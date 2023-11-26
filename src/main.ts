import {
  Modal,
  Notice,
  Plugin,
  Setting,
  setIcon,
  FileSystemAdapter,
  Platform, TAbstractFile
} from "obsidian";
import cloneDeep from "lodash/cloneDeep";
import type {
  FileOrFolderMixedState, RemoteItem,
  RemotelySavePluginSettings,
  SyncTriggerSourceType,
} from "./baseTypes";
import {
  COMMAND_CALLBACK,
  COMMAND_CALLBACK_ONEDRIVE,
  COMMAND_CALLBACK_DROPBOX,
  COMMAND_URI,
} from "./baseTypes";
import { importQrCodeUri } from "./importExport";
import {
  insertDeleteRecordByVault,
  insertRenameRecordByVault,
  insertSyncPlanRecordByVault,
  loadFileHistoryTableByVault,
  prepareDBs,
  InternalDBs,
  insertLoggerOutputByVault,
  clearExpiredLoggerOutputRecords,
  clearExpiredSyncPlanRecords, FileFolderHistoryRecord,
} from "./localdb";
import { RemoteClient } from "./remote";
import {
  DEFAULT_DROPBOX_CONFIG,
  getAuthUrlAndVerifier as getAuthUrlAndVerifierDropbox,
  sendAuthReq as sendAuthReqDropbox,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceDropbox,
} from "./remoteForDropbox";
import { DEFAULT_S3_CONFIG } from "./remoteForS3";
import { DEFAULT_WEBDAV_CONFIG } from "./remoteForWebdav";
import { RemotelySaveSettingTab } from "./settings";
import {fetchMetadataFile, parseRemoteItems, SyncPlanType, SyncStatusType} from "./sync";
import { doActualSync, getSyncPlan, isPasswordOk } from "./sync";
import { messyConfigToNormal, normalConfigToMessy } from "./configPersist";
import { ObsConfigDirFileType, listFilesInObsFolder } from "./obsFolderLister";
import { I18n } from "./i18n";
import type { LangType, LangTypeAndAuto, TransItemType } from "./i18n";

import { DeletionOnRemote, MetadataOnRemote } from "./metadataOnRemote";
import { SyncAlgoV2Modal } from "./syncAlgoV2Notice";
import { applyPresetRulesInplace } from "./presetRules";

import { applyLogWriterInplace, log } from "./moreOnLog";
import AggregateError from "aggregate-error";
import {
  exportVaultLoggerOutputToFiles,
  exportVaultSyncPlansToFiles,
} from "./debugMode";
import { SizesConflictModal } from "./syncSizesConflictNotice";

const DEFAULT_SETTINGS: RemotelySavePluginSettings = {
  s3: DEFAULT_S3_CONFIG,
  webdav: DEFAULT_WEBDAV_CONFIG,
  dropbox: DEFAULT_DROPBOX_CONFIG,
  password: "",
  serviceType: "s3",
  debugEnabled: false,
  // vaultRandomID: "", // deprecated
  autoRunEveryMilliseconds: -1,
  initRunAfterMilliseconds: -1,
  syncOnSaveAfterMilliseconds: -1,
  agreeToUploadExtraMetadata: false,
  concurrency: 5,
  syncConfigDir: false,
  syncUnderscoreItems: false,
  lang: "auto",
  logToDB: false,
  skipSizeLargerThan: -1,
  enableStatusBarInfo: true,
  lastSuccessSync: -1
};

interface OAuth2Info {
  verifier?: string;
  helperModal?: Modal;
  authDiv?: HTMLElement;
  revokeDiv?: HTMLElement;
  revokeAuthSetting?: Setting;
}

const iconNameSyncWait = "rotate-ccw";
const iconNameSyncRunning = "refresh-ccw";
const iconNameLogs = "file-text";

export default class RemotelySavePlugin extends Plugin {
  settings: RemotelySavePluginSettings;
  db: InternalDBs;
  syncStatus: SyncStatusType;
  statusBarElement: HTMLSpanElement;
  oauth2Info: OAuth2Info;
  currSyncMsg?: string;
  syncRibbon?: HTMLElement;
  autoRunIntervalID?: number;
  syncOnSaveIntervalID?: number;
  i18n: I18n;
  vaultRandomID: string;

  async syncRun(triggerSource: SyncTriggerSourceType = "manual") {
    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars);
    };

    const getNotice = (x: string, step: number, timeout?: number) => {
      // only show notices in manual mode
      // no notice in auto mode
      if (triggerSource === "manual" || triggerSource === "dry") {
        if (!this.settings.debugEnabled) {
          // If not mobile and status bar enabled, return.
          if (!Platform.isMobileApp && this.settings.enableStatusBarInfo === true) {
            return;
          }

          // Rewrite step 8 to display as step 2
          if (step == 8) {
            step = 2;
          } else if (step > 1 && step < 8) {
            // Allow all errors ("step -1"). Otherwise skip steps 2 -> 7
            return;
          }
        }
        // Add "step/x" in notice
        const prefix = step > -1 ? step + "/" : "";
        new Notice(prefix + x, timeout);
      }
    };

    if (this.syncStatus !== "idle" && triggerSource == "manual") {
      // here the notice is shown regardless of triggerSource

      new Notice(
        t("syncrun_alreadyrunning", {
          pluginName: this.manifest.name,
          syncStatus: this.syncStatus,
        })
      );

      if (this.currSyncMsg !== undefined && this.currSyncMsg !== "") {
        log.debug(this.currSyncMsg); 
      }
      return;
    }
    let originLabel = this.getOriginLabel();

    try {
      if (this.syncRibbon !== undefined) {
        this.setSyncIconRunning(t, triggerSource);
      }

      const MAX_STEPS = this.settings.debugEnabled ? 8 : 2;

      // Step count will be wrong for dry mode, but that's fine. It already was off by 1
      if (triggerSource === "dry") {
        getNotice(
          t("syncrun_step0", {
            maxSteps: `${MAX_STEPS}`,
          }), 0
        );
      }

      getNotice(
        t("syncrun_step1", {
          maxSteps: `${MAX_STEPS}`,
          serviceType: this.settings.serviceType,
        }), 1
      );
      this.syncStatus = "preparing";

      this.updateStatusBarText(t("syncrun_status_preparing"));

      getNotice(
        t("syncrun_step2", {
          maxSteps: `${MAX_STEPS}`,
        }), 2
      );
      this.syncStatus = "getting_remote_files_list";
      const self = this;
      const client = this.getRemoteClient(self);
      const remoteRsp = await client.listFromRemote();

      getNotice(
        t("syncrun_step3", {
          maxSteps: `${MAX_STEPS}`,
        }), 3
      );
      this.syncStatus = "checking_password";
      const passwordCheckResult = await isPasswordOk(
        remoteRsp.Contents,
        this.settings.password
      );
      if (!passwordCheckResult.ok) {
        getNotice(t("syncrun_passworderr"), -1, 10 * 1000);
        throw Error(passwordCheckResult.reason);
      }

      getNotice(
        t("syncrun_step4", {
          maxSteps: `${MAX_STEPS}`,
        }), 4
      );
      this.syncStatus = "getting_remote_extra_meta";
      const { remoteStates, metadataFile } = await this.parseRemoteItems(remoteRsp.Contents, client);
      const origMetadataOnRemote = await this.fetchMetadataFromRemote(metadataFile, client);

      getNotice(
        t("syncrun_step5", {
          maxSteps: `${MAX_STEPS}`,
        }), 5
      );
      this.syncStatus = "getting_local_meta";
      const local = this.app.vault.getAllLoadedFiles();
      const localHistory = await this.getLocalHistory();
      let localConfigDirContents: ObsConfigDirFileType[] = await this.listFilesInObsFolder();

      getNotice(
        t("syncrun_step6", {
          maxSteps: `${MAX_STEPS}`,
        }), 6
      );
      this.syncStatus = "generating_plan";
      const { plan, sortedKeys, deletions, sizesGoWrong } = await this.getSyncPlan(remoteStates, local, localConfigDirContents, origMetadataOnRemote, localHistory, client, triggerSource);

      await insertSyncPlanRecordByVault(this.db, plan, this.vaultRandomID);

      // The operations above are almost read only and kind of safe.
      // The operations below begins to write or delete (!!!) something.

      if (triggerSource !== "dry") {
        getNotice(
          t("syncrun_step7", {
            maxSteps: `${MAX_STEPS}`,
          }), 7
        );

        this.syncStatus = "syncing";
        await this.doActualSync(client, plan, sortedKeys, metadataFile, origMetadataOnRemote, sizesGoWrong, deletions, self);
      } else {
        this.syncStatus = "syncing";
        getNotice(
          t("syncrun_step7skip", {
            maxSteps: `${MAX_STEPS}`,
          }), 7
        );
      }

      getNotice(
        t("syncrun_step8", {
          maxSteps: `${MAX_STEPS}`,
        }), 8
      );
      this.syncStatus = "finish";
      this.syncStatus = "idle";

      this.updateLastSyncTime();
    } catch (error) {
      const msg = t("syncrun_abort", {
        manifestID: this.manifest.id,
        theDate: `${Date.now()}`,
        triggerSource: triggerSource,
        syncStatus: this.syncStatus,
      });
      log.error(msg);
      log.error(error);
      getNotice(msg, -1,  10 * 1000);
      if (error instanceof AggregateError) {
        for (const e of error.errors) {
          getNotice(e.message, -1,  10 * 1000);
        }
      } else {
        getNotice(error.message, -1, 10 * 1000);
      }
      this.syncStatus = "idle";
      if (this.syncRibbon !== undefined) {
        setIcon(this.syncRibbon, iconNameSyncWait);
        this.syncRibbon.setAttribute("aria-label", originLabel);
      }
    }
  }

  private getOriginLabel() {
    let originLabel = `${this.manifest.name}`;
    if (this.syncRibbon !== undefined) {
      originLabel = this.syncRibbon.getAttribute("aria-label");
    }
    return originLabel;
  }

  private updateLastSyncTime() {
    this.settings.lastSuccessSync = Date.now();
    this.saveSettings();

    this.updateLastSuccessSyncMsg(this.settings.lastSuccessSync);

    if (this.syncRibbon !== undefined) {
      setIcon(this.syncRibbon, iconNameSyncWait);
      this.syncRibbon.setAttribute("aria-label", this.getOriginLabel());
    }
  }

  private async doActualSync(client: RemoteClient, plan: SyncPlanType, sortedKeys: string[], metadataFile: FileOrFolderMixedState, origMetadataOnRemote: MetadataOnRemote, sizesGoWrong: FileOrFolderMixedState[], deletions: DeletionOnRemote[], self: this) {
    await doActualSync(
      client,
      this.db,
      this.vaultRandomID,
      this.app.vault,
      plan,
      sortedKeys,
      metadataFile,
      origMetadataOnRemote,
      sizesGoWrong,
      deletions,
      (key: string) => self.trash(key),
      this.settings.password,
      this.settings.concurrency,
      (ss: FileOrFolderMixedState[]) => {
        new SizesConflictModal(
          self.app,
          self,
          this.settings.skipSizeLargerThan,
          ss,
          this.settings.password !== ""
        ).open();
      },
      (i: number, totalCount: number, pathName: string, decision: string) =>
        self.setCurrSyncMsg(i, totalCount, pathName, decision)
    );
  }

  private async getSyncPlan(remoteStates: FileOrFolderMixedState[], local: TAbstractFile[], localConfigDirContents: ObsConfigDirFileType[], origMetadataOnRemote: MetadataOnRemote, localHistory: FileFolderHistoryRecord[], client: RemoteClient, triggerSource: "manual" | "auto" | "autoOnceInit" | "dry") {
    return await getSyncPlan(
      remoteStates,
      local,
      localConfigDirContents,
      origMetadataOnRemote.deletions,
      localHistory,
      client.serviceType,
      triggerSource,
      this.app.vault,
      this.settings.syncConfigDir,
      this.app.vault.configDir,
      this.settings.syncUnderscoreItems,
      this.settings.skipSizeLargerThan,
      this.settings.password
    );
  }

  private async listFilesInObsFolder() {
    return await listFilesInObsFolder(
      this.app.vault.configDir,
      this.app.vault,
      this.manifest.id
    );
  }

  private async getLocalHistory() {
    return await loadFileHistoryTableByVault(
      this.db,
      this.vaultRandomID
    );
  }

  private async fetchMetadataFromRemote(metadataFile: FileOrFolderMixedState, client: RemoteClient) {
    return await fetchMetadataFile(
      metadataFile,
      client,
      this.app.vault,
      this.settings.password
    );
  }

  private async parseRemoteItems(contents: RemoteItem[], client: RemoteClient) {
    return await parseRemoteItems(
      contents,
      this.db,
      this.vaultRandomID,
      client.serviceType,
      this.settings.password
    );
  }

  private getRemoteClient(self: this) {
    const client = new RemoteClient(
      this.settings.serviceType,
      this.settings.s3,
      this.settings.webdav,
      this.settings.dropbox,
      undefined,
      this.app.vault.getName(),
      () => self.saveSettings()
    );
    return client;
  }

  private setSyncIconRunning(t: (x: TransItemType, vars?: any) => string, triggerSource: "manual" | "auto" | "dry" | "autoOnceInit") {
    setIcon(this.syncRibbon, iconNameSyncRunning);
    this.syncRibbon.setAttribute(
      "aria-label",
      t("syncrun_syncingribbon", {
        pluginName: this.manifest.name,
        triggerSource: triggerSource,
      })
    );
  }

  async onload() {
    this.oauth2Info = {
      verifier: "",
      helperModal: undefined,
      authDiv: undefined,
      revokeDiv: undefined,
      revokeAuthSetting: undefined,
    }; // init

    this.currSyncMsg = "";

    await this.loadSettings();
    await this.checkIfPresetRulesFollowed();

    // lang should be load early, but after settings
    this.i18n = new I18n(this.settings.lang, async (lang: LangTypeAndAuto) => {
      this.settings.lang = lang;
      await this.saveSettings();
    });
    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars);
    };

    if (this.settings.debugEnabled) {
      log.setLevel("debug");
    }

    await this.checkIfOauthExpires();

    // MUST before prepareDB()
    // And, it's also possible to be an empty string,
    // which means the vaultRandomID is read from db later!
    const vaultRandomIDFromOldConfigFile =
      await this.getVaultRandomIDFromOldConfigFile();

    // no need to await this
    this.tryToAddIgnoreFile();

    const vaultBasePath = this.getVaultBasePath();

    try {
      await this.prepareDBAndVaultRandomID(
        vaultBasePath,
        vaultRandomIDFromOldConfigFile
      );
    } catch (err) {
      new Notice(err.message, 10 * 1000);
      throw err;
    }

    // must AFTER preparing DB
    this.addOutputToDBIfSet();
    this.enableAutoClearOutputToDBHistIfSet();

    // must AFTER preparing DB
    this.enableAutoClearSyncPlanHist();

    this.syncStatus = "idle";

    this.registerEvent(
      this.app.vault.on("delete", async (fileOrFolder) => {
        await insertDeleteRecordByVault(
          this.db,
          fileOrFolder,
          this.vaultRandomID
        );
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", async (fileOrFolder, oldPath) => {
        await insertRenameRecordByVault(
          this.db,
          fileOrFolder,
          oldPath,
          this.vaultRandomID
        );
      })
    );

    this.registerObsidianProtocolHandler(COMMAND_URI, async (inputParams) => {
      const parsed = importQrCodeUri(inputParams, this.app.vault.getName());
      if (parsed.status === "error") {
        new Notice(parsed.message);
      } else {
        const copied = cloneDeep(parsed.result);
        // new Notice(JSON.stringify(copied))
        this.settings = Object.assign({}, this.settings, copied);
        this.saveSettings();
        new Notice(
          t("protocol_saveqr", {
            manifestName: this.manifest.name,
          })
        );
      }
    });

    this.registerObsidianProtocolHandler(
      COMMAND_CALLBACK,
      async (inputParams) => {
        new Notice(
          t("protocol_callbacknotsupported", {
            params: JSON.stringify(inputParams),
          })
        );
      }
    );

    this.registerObsidianProtocolHandler(
      COMMAND_CALLBACK_DROPBOX,
      async (inputParams) => {
        if (inputParams.code !== undefined) {
          if (this.oauth2Info.helperModal !== undefined) {
            this.oauth2Info.helperModal.contentEl.empty();

            t("protocol_dropbox_connecting")
              .split("\n")
              .forEach((val) => {
                this.oauth2Info.helperModal.contentEl.createEl("p", {
                  text: val,
                });
              });
          }

          let authRes = await sendAuthReqDropbox(
            this.settings.dropbox.clientID,
            this.oauth2Info.verifier,
            inputParams.code
          );

          const self = this;
          setConfigBySuccessfullAuthInplaceDropbox(
            this.settings.dropbox,
            authRes,
            () => self.saveSettings()
          );

          const client = new RemoteClient(
            "dropbox",
            undefined,
            undefined,
            this.settings.dropbox,
            undefined,
            this.app.vault.getName(),
            () => self.saveSettings()
          );

          const username = await client.getUser();
          this.settings.dropbox.username = username;
          await this.saveSettings();

          new Notice(
            t("protocol_dropbox_connect_succ", {
              username: username,
            })
          );

          this.oauth2Info.verifier = ""; // reset it
          this.oauth2Info.helperModal?.close(); // close it
          this.oauth2Info.helperModal = undefined;

          this.oauth2Info.authDiv?.toggleClass(
            "dropbox-auth-button-hide",
            this.settings.dropbox.username !== ""
          );
          this.oauth2Info.authDiv = undefined;

          this.oauth2Info.revokeAuthSetting?.setDesc(
            t("protocol_dropbox_connect_succ_revoke", {
              username: this.settings.dropbox.username,
            })
          );
          this.oauth2Info.revokeAuthSetting = undefined;
          this.oauth2Info.revokeDiv?.toggleClass(
            "dropbox-revoke-auth-button-hide",
            this.settings.dropbox.username === ""
          );
          this.oauth2Info.revokeDiv = undefined;
        } else {
          new Notice(t("protocol_dropbox_connect_fail"));
          throw Error(
            t("protocol_dropbox_connect_unknown", {
              params: JSON.stringify(inputParams),
            })
          );
        }
      }
    );

    this.syncRibbon = this.addRibbonIcon(
      iconNameSyncWait,
      `${this.manifest.name}`,
      async () => this.syncRun("manual")
    );

    if (!Platform.isMobileApp && this.settings.enableStatusBarInfo === true) {
      const statusBarItem = this.addStatusBarItem();
      this.statusBarElement = statusBarItem.createEl("span");
      this.statusBarElement.setAttribute("aria-label-position", "top");

      this.updateLastSuccessSyncMsg(this.settings.lastSuccessSync);
      // update statusbar text every 30 seconds
      this.registerInterval(window.setInterval(() => {
        this.updateLastSuccessSyncMsg(this.settings.lastSuccessSync);
      }, 1000 * 30));
    }

    this.addCommand({
      id: "start-sync",
      name: t("command_startsync"),
      icon: iconNameSyncWait,
      callback: async () => {
        this.syncRun("manual");
      },
    });

    this.addCommand({
      id: "start-sync-dry-run",
      name: t("command_drynrun"),
      icon: iconNameSyncWait,
      callback: async () => {
        this.syncRun("dry");
      },
    });

    this.addCommand({
      id: "export-sync-plans-json",
      name: t("command_exportsyncplans_json"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          "json"
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addCommand({
      id: "export-sync-plans-table",
      name: t("command_exportsyncplans_table"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          "table"
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addCommand({
      id: "export-logs-in-db",
      name: t("command_exportlogsindb"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultLoggerOutputToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID
        );
        new Notice(t("settings_logtodbexport_notice"));
      },
    });

    this.addSettingTab(new RemotelySaveSettingTab(this.app, this));

    // this.registerDomEvent(document, "click", (evt: MouseEvent) => {
    //   log.info("click", evt);
    // });

    if (!this.settings.agreeToUploadExtraMetadata) {
      const syncAlgoV2Modal = new SyncAlgoV2Modal(this.app, this);
      syncAlgoV2Modal.open();
    } else {
      this.enableAutoSyncIfSet();
      this.enableInitSyncIfSet();
      this.enableSyncOnSaveIfSet();
    }
  }

  async onunload() {
    this.syncRibbon = undefined;
    if (this.oauth2Info !== undefined) {
      this.oauth2Info.helperModal = undefined;
      this.oauth2Info = undefined;
    }
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      cloneDeep(DEFAULT_SETTINGS),
      messyConfigToNormal(await this.loadData())
    );
    if (this.settings.dropbox.clientID === "") {
      this.settings.dropbox.clientID = DEFAULT_SETTINGS.dropbox.clientID;
    }
    if (this.settings.dropbox.remoteBaseDir === undefined) {
      this.settings.dropbox.remoteBaseDir = "";
    }
    if (this.settings.webdav.manualRecursive === undefined) {
      this.settings.webdav.manualRecursive = false;
    }
    if (this.settings.webdav.depth === undefined) {
      this.settings.webdav.depth = "auto_unknown";
    }
    if (this.settings.webdav.remoteBaseDir === undefined) {
      this.settings.webdav.remoteBaseDir = "";
    }
    if (this.settings.s3.partsConcurrency === undefined) {
      this.settings.s3.partsConcurrency = 20;
    }
    if (this.settings.s3.forcePathStyle === undefined) {
      this.settings.s3.forcePathStyle = false;
    }
  }

  async checkIfPresetRulesFollowed() {
    const res = applyPresetRulesInplace(this.settings);
    if (res.changed) {
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(normalConfigToMessy(this.settings));
  }

  async checkIfOauthExpires() {
    let needSave: boolean = false;
    const current = Date.now();

    // fullfill old version settings
    if (
      this.settings.dropbox.refreshToken !== "" &&
      this.settings.dropbox.credentialsShouldBeDeletedAtTime === undefined
    ) {
      // It has a refreshToken, but not expire time.
      // Likely to be a setting from old version.
      // we set it to a month.
      this.settings.dropbox.credentialsShouldBeDeletedAtTime =
        current + 1000 * 60 * 60 * 24 * 30;
      needSave = true;
    }

    // check expired or not
    let dropboxExpired = false;
    if (
      this.settings.dropbox.refreshToken !== "" &&
      current >= this.settings.dropbox.credentialsShouldBeDeletedAtTime
    ) {
      dropboxExpired = true;
      this.settings.dropbox = cloneDeep(DEFAULT_DROPBOX_CONFIG);
      needSave = true;
    }

    // save back
    if (needSave) {
      await this.saveSettings();
    }

    // send notice
    if (dropboxExpired) {
      new Notice(
        `${this.manifest.name}: You haven't manually auth Dropbox for a while, you need to re-auth it again.`,
        6000
      );
    }
  }

  async getVaultRandomIDFromOldConfigFile() {
    let vaultRandomID = "";
    if (this.settings.vaultRandomID !== undefined) {
      // In old version, the vault id is saved in data.json
      // But we want to store it in localForage later
      if (this.settings.vaultRandomID !== "") {
        // a real string was assigned before
        vaultRandomID = this.settings.vaultRandomID;
      }
      delete this.settings.vaultRandomID;
      await this.saveSettings();
    }
    return vaultRandomID;
  }

  async trash(x: string) {
    if (!(await this.app.vault.adapter.trashSystem(x))) {
      await this.app.vault.adapter.trashLocal(x);
    }
  }

  getVaultBasePath() {
    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      // in desktop
      return this.app.vault.adapter.getBasePath().split("?")[0];
    } else {
      // in mobile
      return this.app.vault.adapter.getResourcePath("").split("?")[0];
    }
  }

  async prepareDBAndVaultRandomID(
    vaultBasePath: string,
    vaultRandomIDFromOldConfigFile: string
  ) {
    const { db, vaultRandomID } = await prepareDBs(
      vaultBasePath,
      vaultRandomIDFromOldConfigFile
    );
    this.db = db;
    this.vaultRandomID = vaultRandomID;
  }

  enableSyncOnSaveIfSet() {
    if (
      this.settings.syncOnSaveAfterMilliseconds !== undefined &&
      this.settings.syncOnSaveAfterMilliseconds !== null &&
      this.settings.syncOnSaveAfterMilliseconds > 0
    ) {
      let runScheduled = false;
      this.app.workspace.onLayoutReady(() => {
        const intervalID = window.setInterval(() => {
          const currentFile = this.app.workspace.getActiveFile();

          if (currentFile) {
            // get the last modified time of the current file
            // if it has been modified within the last syncOnSaveAfterMilliseconds
            // then schedule a run for syncOnSaveAfterMilliseconds after it was modified
            const lastModified = currentFile.stat.mtime;
            const currentTime = Date.now();
            if (currentTime - lastModified < this.settings.syncOnSaveAfterMilliseconds) {
              if (!runScheduled) {
                const scheduleTimeFromNow = this.settings.syncOnSaveAfterMilliseconds - (currentTime - lastModified)
                log.debug(`schedule a run for ${scheduleTimeFromNow} milliseconds later`)
                runScheduled = true
                setTimeout(() => {
                  this.syncRun("auto")
                  runScheduled = false
                },
                  scheduleTimeFromNow
                )
              }
            }
          }
        }, 1_000);
        this.syncOnSaveIntervalID = intervalID;
        this.registerInterval(intervalID);
      });
    }
  }

  enableAutoSyncIfSet() {
    if (
      this.settings.autoRunEveryMilliseconds !== undefined &&
      this.settings.autoRunEveryMilliseconds !== null &&
      this.settings.autoRunEveryMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        const intervalID = window.setInterval(() => {
          this.syncRun("auto");
        }, this.settings.autoRunEveryMilliseconds);
        this.autoRunIntervalID = intervalID;
        this.registerInterval(intervalID);
      });
    }
  }

  enableInitSyncIfSet() {
    if (
      this.settings.initRunAfterMilliseconds !== undefined &&
      this.settings.initRunAfterMilliseconds !== null &&
      this.settings.initRunAfterMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => {
          this.syncRun("autoOnceInit");
        }, this.settings.initRunAfterMilliseconds);
      });
    }
  }

  async saveAgreeToUseNewSyncAlgorithm() {
    this.settings.agreeToUploadExtraMetadata = true;
    await this.saveSettings();
  }

  async setCurrSyncMsg(
    i: number,
    totalCount: number,
    pathName: string,
    decision: string
  ) {
    const msg = `syncing progress=${i}/${totalCount},decision=${decision},path=${pathName}`;
    log.debug(msg);
    this.currSyncMsg = msg;
    this.updateStatusBarText(this.i18n.t("syncrun_status_progress", {
      current: i.toString(),
      total: totalCount.toString()
    }));
  
    
  }

  updateStatusBarText(statusText: string) {
    if (this.statusBarElement === undefined) return;
    if (!Platform.isMobileApp && this.settings.enableStatusBarInfo === true) {
      this.statusBarElement.setText(statusText);
    }
  }

  // TODO: Refactor this into misc.ts or elsewhere
  updateLastSuccessSyncMsg(lastSuccessSyncMillis?: number) {
    if (this.statusBarElement === undefined) return;

    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars);
    };

    let lastSyncMsg = t("statusbar_lastsync_never");
    let lastSyncLabelMsg = t("statusbar_lastsync_never_label");

    if (lastSuccessSyncMillis !== undefined && lastSuccessSyncMillis > 0) {
      const deltaTime = Date.now() - lastSuccessSyncMillis;

      // create human readable time
      const years = Math.floor(deltaTime / 31556952000);
      const months = Math.floor(deltaTime / 2629746000);
      const weeks = Math.floor(deltaTime / 604800000);
      const days = Math.floor(deltaTime / 86400000);
      const hours = Math.floor(deltaTime / 3600000);
      const minutes = Math.floor(deltaTime / 60000);
      let timeText = "";

      if (years > 0) {
        timeText = t("statusbar_time_years", { time: years });
      } else if (months > 0) {
        timeText = t("statusbar_time_months", { time: months });
      } else if (weeks > 0) {
        timeText = t("statusbar_time_weeks", { time: weeks });
      } else if (days > 0) {
        timeText = t("statusbar_time_days", { time: days });
      } else if (hours > 0) {
        timeText = t("statusbar_time_hours", { time: hours });
      } else if (minutes > 0) {
        timeText = t("statusbar_time_minutes", { time: minutes });
      } else {
        timeText = t("statusbar_time_lessminute");
      }

      let dateText = new Date(lastSuccessSyncMillis)
        .toLocaleTimeString(navigator.language, {
          weekday: "long", year: "numeric", month: "long", day: "numeric"
        });

      lastSyncMsg = t("statusbar_lastsync", { time: timeText });
      lastSyncLabelMsg = t("statusbar_lastsync_label", { date: dateText });
    }

    this.statusBarElement.setText(lastSyncMsg);
    this.statusBarElement.setAttribute("aria-label", lastSyncLabelMsg);
  }

  /**
   * Because data.json contains sensitive information,
   * We usually want to ignore it in the version control.
   * However, if there's already a an ignore file (even empty),
   * we respect the existing configure and not add any modifications.
   * @returns
   */
  async tryToAddIgnoreFile() {
    const pluginConfigDir = this.manifest.dir;
    const pluginConfigDirExists = await this.app.vault.adapter.exists(
      pluginConfigDir
    );
    if (!pluginConfigDirExists) {
      // what happened?
      return;
    }
    const ignoreFile = `${pluginConfigDir}/.gitignore`;
    const ignoreFileExists = await this.app.vault.adapter.exists(ignoreFile);

    const contentText = "data.json\n";

    try {
      if (!ignoreFileExists) {
        // not exists, directly create
        // no need to await
        this.app.vault.adapter.write(ignoreFile, contentText);
      }
    } catch (error) {
      // just skip
    }
  }

  addOutputToDBIfSet() {
    if (this.settings.logToDB) {
      applyLogWriterInplace((...msg: any[]) => {
        insertLoggerOutputByVault(this.db, this.vaultRandomID, ...msg);
      });
    }
  }

  enableAutoClearOutputToDBHistIfSet() {
    const initClearOutputToDBHistAfterMilliseconds = 1000 * 45;
    const autoClearOutputToDBHistAfterMilliseconds = 1000 * 60 * 5;

    this.app.workspace.onLayoutReady(() => {
      // init run
      window.setTimeout(() => {
        if (this.settings.logToDB) {
          clearExpiredLoggerOutputRecords(this.db);
        }
      }, initClearOutputToDBHistAfterMilliseconds);

      // scheduled run
      const intervalID = window.setInterval(() => {
        if (this.settings.logToDB) {
          clearExpiredLoggerOutputRecords(this.db);
        }
      }, autoClearOutputToDBHistAfterMilliseconds);
      this.registerInterval(intervalID);
    });
  }

  enableAutoClearSyncPlanHist() {
    const initClearSyncPlanHistAfterMilliseconds = 1000 * 45;
    const autoClearSyncPlanHistAfterMilliseconds = 1000 * 60 * 5;

    this.app.workspace.onLayoutReady(() => {
      // init run
      window.setTimeout(() => {
        clearExpiredSyncPlanRecords(this.db);
      }, initClearSyncPlanHistAfterMilliseconds);

      // scheduled run
      const intervalID = window.setInterval(() => {
        clearExpiredSyncPlanRecords(this.db);
      }, autoClearSyncPlanHistAfterMilliseconds);
      this.registerInterval(intervalID);
    });
  }
}
