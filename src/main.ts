import {
  Modal,
  Notice,
  Plugin,
  Setting,
  setIcon,
  FileSystemAdapter,
  Platform, TAbstractFile, Vault, EventRef
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
import {
  AccessCodeResponseSuccessfulType,
  DEFAULT_ONEDRIVE_CONFIG,
  sendAuthReq as sendAuthReqOnedrive,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceOnedrive,
} from "./remoteForOnedrive";
import { DEFAULT_S3_CONFIG } from "./remoteForS3";
import { DEFAULT_WEBDAV_CONFIG } from "./remoteForWebdav";
import { RemotelySaveSettingTab } from "./settings";
import {fetchMetadataFile, parseRemoteItems, SyncPlanType, SyncStatusType} from "./sync";
import { doActualSync, getSyncPlan, isPasswordOk, getMetadataPath } from "./sync";
import { messyConfigToNormal, normalConfigToMessy } from "./configPersist";
import { ObsConfigDirFileType, listFilesInObsFolder } from "./obsFolderLister";
import { I18n } from "./i18n";
import type { LangType, LangTypeAndAuto, TransItemType } from "./i18n";

import {DeletionOnRemote, deserializeMetadataOnRemote, MetadataOnRemote} from "./metadataOnRemote";
import { SyncAlgoV2Modal } from "./syncAlgoV2Notice";
import { applyPresetRulesInplace } from "./presetRules";

import { applyLogWriterInplace, log } from "./moreOnLog";
import AggregateError from "aggregate-error";
import {
  exportVaultLoggerOutputToFiles,
  exportVaultSyncPlansToFiles,
} from "./debugMode";
import { SizesConflictModal } from "./syncSizesConflictNotice";
import {mkdirpInVault, getLastSynced} from "./misc";

const DEFAULT_SETTINGS: RemotelySavePluginSettings = {
  s3: DEFAULT_S3_CONFIG,
  webdav: DEFAULT_WEBDAV_CONFIG,
  dropbox: DEFAULT_DROPBOX_CONFIG,
  onedrive: DEFAULT_ONEDRIVE_CONFIG,
  password: "",
  serviceType: "s3",
  debugEnabled: false,
  // vaultRandomID: "", // deprecated
  autoRunEveryMilliseconds: -1,
  initRunAfterMilliseconds: -1,
  syncOnSaveAfterMilliseconds: -1,
  syncOnRemoteChangesAfterMilliseconds: -1,
  agreeToUploadExtraMetadata: false,
  concurrency: 5,
  syncConfigDir: false,
  syncUnderscoreItems: false,
  lang: "auto",
  logToDB: false,
  skipSizeLargerThan: -1,
  enableStatusBarInfo: true,
  showLastSyncedOnly: false,
  lastSynced: -1,
  trashLocal: false,
  syncTrash: false,
  syncBookmarks: true,
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
const iconNameStatusBar = "refresh-ccw-dot";
const iconNameLogs = "file-text";

export default class RemotelySavePlugin extends Plugin {
  settings: RemotelySavePluginSettings;
  db: InternalDBs;
  syncStatus: SyncStatusType;
  syncStatusText?: string;
  statusBarElement: HTMLSpanElement;
  oauth2Info: OAuth2Info;
  currSyncMsg?: string;
  syncRibbon?: HTMLElement;
  autoRunIntervalID?: number;
  i18n: I18n;
  vaultRandomID: string;
  isManual: boolean;
  isAlreadyRunning: boolean;
  syncOnSaveEvent?: EventRef;
  vaultScannerIntervalId?: number;
  syncOnRemoteIntervalID?: number;
  statusBarIntervalID: number;

  async syncRun(triggerSource: SyncTriggerSourceType = "manual") {
    this.isManual = triggerSource === "manual";
    this.isAlreadyRunning = false;
    const MAX_STEPS = this.settings.debugEnabled ? 8 : 2;
    await this.createTrashIfDoesNotExist();

    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars);
    };

    const getNotice = (x: string, step: number, timeout?: number) => {
      if (this.isManual || triggerSource === "manual" || triggerSource === "dry") {
        // Display mobile or desktop without status bar notices or if already running notice appears
        if (!this.settings.debugEnabled) {
          if (this.isAlreadyRunning || Platform.isMobile || !this.settings.enableStatusBarInfo) {
            if (step === 1) {
              new Notice("1/" + this.i18n.t("syncrun_step1", {
                maxSteps: "2", serviceType: this.settings.serviceType
              }), timeout);
            } else if (step === 8) {
              new Notice("2/" + this.i18n.t("syncrun_step8", {maxSteps: "2"}), timeout);
            }
          }
          
          return;
        }

        // Display debug notices
        const prefix = step > -1 ? step + "/" : "";
        new Notice(prefix + x, timeout);
      }
    };

    // Make sure two syncs can't run at the same time
    if (this.syncStatus !== "idle") {
      if (triggerSource == "manual") {
        // Show notice for debug, mobile, or desktop
        if (this.settings.debugEnabled) {
          new Notice(t("syncrun_debug_alreadyrunning", {stage: this.syncStatus}));
        } else {
          new Notice("1/" + t("syncrun_alreadyrunning", {maxSteps: MAX_STEPS}));
          this.isAlreadyRunning = true;
        }

        log.debug(this.manifest.name, " already running in stage: ", this.syncStatus);

        if (this.currSyncMsg !== undefined && this.currSyncMsg !== "") {
          log.debug(this.currSyncMsg);
        }  
      }

      return;
    }

    try {
      this.setSyncIcon(true, triggerSource);

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

      this.updateSyncStatus("preparing");

      getNotice(
        t("syncrun_step2", {
          maxSteps: `${MAX_STEPS}`,
        }), 2
      );
      this.updateSyncStatus("getting_remote_files_list");
      const self = this;
      const client = this.getRemoteClient(self);
      const remoteRsp = await client.listFromRemote();

      getNotice(
        t("syncrun_step3", {
          maxSteps: `${MAX_STEPS}`,
        }), 3
      );

      this.updateSyncStatus("checking_password");
      
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
      this.updateSyncStatus("getting_remote_extra_meta");
      const { remoteStates, metadataFile } = await this.parseRemoteItems(remoteRsp.Contents, client);
      const origMetadataOnRemote = await this.fetchMetadataFromRemote(metadataFile, client);

      getNotice(
        t("syncrun_step5", {
          maxSteps: `${MAX_STEPS}`,
        }), 5
      );
      this.updateSyncStatus("getting_local_meta");
      const local = this.app.vault.getAllLoadedFiles();
      const localHistory = await this.getLocalHistory();
      let localConfigDirContents: ObsConfigDirFileType[] = await listFilesInObsFolder(this.app.vault, this.manifest.name, this.settings.syncTrash);

      getNotice(
        t("syncrun_step6", {
          maxSteps: `${MAX_STEPS}`,
        }), 6
      );

      this.updateSyncStatus("generating_plan");
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

        this.updateSyncStatus("syncing");
        await this.doActualSync(client, plan, sortedKeys, metadataFile, origMetadataOnRemote, sizesGoWrong, deletions, self);
      } else {
        this.updateSyncStatus("syncing");
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

      this.updateSyncStatus("finish");

      this.settings.lastSynced = await this.getMetadataMtime();
      this.saveSettings();

      this.updateSyncStatus("idle");
      this.setSyncIcon(false);
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
      this.updateSyncStatus("idle");
      this.setSyncIcon(false);
    }
  }

  private async createTrashIfDoesNotExist() {
    if (this.settings.syncTrash) {
      // when syncing to a device which never trashed a file we will error if this folder does not exist
      await this.createTrashFolderIfDoesNotExist(this.app.vault);
    }
  }

  private shouldSyncBasedOnSyncPlan = async (syncPlan: SyncPlanType) => {
    for (const key in syncPlan.mixedStates) {
      const fileState = syncPlan.mixedStates[key];

      if (fileState.existLocal && fileState.existRemote && fileState.mtimeLocal! > fileState.mtimeRemote!) {
        return true;
      }
    }
    return false;
  };

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
      this.settings.lastSynced,
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
      (i: number, total: number) => self.updateStatusBar({i, total})
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
      this.settings.syncTrash,
      this.settings.syncBookmarks,
      this.app.vault.configDir,
      this.settings.syncUnderscoreItems,
      this.settings.skipSizeLargerThan,
      this.settings.password
    );
  }

  private async getLocalHistory() {
    return await loadFileHistoryTableByVault(
      this.db,
      this.vaultRandomID
    );
  }

  private async fetchMetadataFromRemote(metadataFile: FileOrFolderMixedState, client: RemoteClient) {
    if (metadataFile === undefined) {
      log.debug("no metadata file, so no fetch");
      return {
        deletions: [],
      } as MetadataOnRemote;
    }

    const buf = await client.downloadFromRemote(
      metadataFile.key,
      this.app.vault,
      metadataFile.mtimeRemote,
      this.settings.password,
      metadataFile.remoteEncryptedKey,
      true
    );
    return deserializeMetadataOnRemote(buf);
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
      this.settings.onedrive,
      this.app.vault.getName(),
      () => self.saveSettings()
    );
    return client;
  }

  private updateSyncStatus(status: SyncStatusType) {
    this.syncStatus = status;
    this.updateStatusBar();
  }

  private setSyncIcon(running: boolean, triggerSource?: "manual" | "auto" | "dry" | "autoOnceInit") {
    if (this.syncRibbon === undefined) {
      return;
    }

    if (running) {
      setIcon(this.syncRibbon, iconNameSyncRunning);

      this.syncRibbon.setAttribute(
        "aria-label",
        this.i18n.t("syncrun_syncingribbon", {
          pluginName: this.manifest.name,
          triggerSource: triggerSource,
        })
      );
    } else {
      setIcon(this.syncRibbon, iconNameSyncWait);
      
      this.syncRibbon.setAttribute("aria-label", this.manifest.name);
    }
  }

  private updateStatusBar(syncQueue?: {i: number, total: number}) {
    const enabled = this.statusBarElement !== undefined && 
      this.settings.enableStatusBarInfo === true;

    // Update status text
    if (this.syncStatus === "idle") {
      const lastSynced = getLastSynced(this.i18n, this.settings.lastSynced);
      this.syncStatusText = lastSynced.lastSyncMsg;

      if (enabled) {
        this.statusBarElement.setAttribute("aria-label", lastSynced.lastSyncLabelMsg);
      }
    } 
    
    if (this.syncStatus === "preparing") {
      this.syncStatusText = this.i18n.t("syncrun_status_preparing");
    }

    if (this.syncStatus === "syncing") {
      if (syncQueue !== undefined) {
        this.syncStatusText = this.i18n.t("syncrun_status_progress", {
          current: syncQueue.i.toString(),
          total: syncQueue.total.toString()
        });  
      } else {
        this.syncStatusText = this.i18n.t("syncrun_status_syncing");
      }
    }

    if (enabled) {
      this.statusBarElement.setText(this.syncStatusText);
    }
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

    this.updateSyncStatus("idle");

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

    this.registerObsidianProtocolHandler(
      COMMAND_CALLBACK_ONEDRIVE,
      async (inputParams) => {
        if (inputParams.code !== undefined) {
          if (this.oauth2Info.helperModal !== undefined) {
            this.oauth2Info.helperModal.contentEl.empty();

            t("protocol_onedrive_connecting")
              .split("\n")
              .forEach((val) => {
                this.oauth2Info.helperModal.contentEl.createEl("p", {
                  text: val,
                });
              });
          }

          let rsp = await sendAuthReqOnedrive(
            this.settings.onedrive.clientID,
            this.settings.onedrive.authority,
            inputParams.code,
            this.oauth2Info.verifier
          );

          if ((rsp as any).error !== undefined) {
            throw Error(`${JSON.stringify(rsp)}`);
          }

          const self = this;
          setConfigBySuccessfullAuthInplaceOnedrive(
            this.settings.onedrive,
            rsp as AccessCodeResponseSuccessfulType,
            () => self.saveSettings()
          );

          const client = new RemoteClient(
            "onedrive",
            undefined,
            undefined,
            undefined,
            this.settings.onedrive,
            this.app.vault.getName(),
            () => self.saveSettings()
          );
          this.settings.onedrive.username = await client.getUser();
          await this.saveSettings();

          this.oauth2Info.verifier = ""; // reset it
          this.oauth2Info.helperModal?.close(); // close it
          this.oauth2Info.helperModal = undefined;

          this.oauth2Info.authDiv?.toggleClass(
            "onedrive-auth-button-hide",
            this.settings.onedrive.username !== ""
          );
          this.oauth2Info.authDiv = undefined;

          this.oauth2Info.revokeAuthSetting?.setDesc(
            t("protocol_onedrive_connect_succ_revoke", {
              username: this.settings.onedrive.username,
            })
          );
          this.oauth2Info.revokeAuthSetting = undefined;
          this.oauth2Info.revokeDiv?.toggleClass(
            "onedrive-revoke-auth-button-hide",
            this.settings.onedrive.username === ""
          );
          this.oauth2Info.revokeDiv = undefined;
        } else {
          new Notice(t("protocol_onedrive_connect_fail"));
          throw Error(
            t("protocol_onedrive_connect_unknown", {
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

    this.addCommand({
      id: "get-sync-status",
      name: t("command_syncstatus"),
      icon: iconNameStatusBar,
      callback: () => new Notice(this.syncStatusText)
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
      this.toggleSyncOnRemote(true);
      this.toggleSyncOnSave(true);
      this.toggleStatusBar(true);
      this.toggleStatusText(true);
    }
  }

  async onunload() {
    this.syncRibbon = undefined;
    if (this.oauth2Info !== undefined) {
      this.oauth2Info.helperModal = undefined;
      this.oauth2Info = undefined;
    }
    
    // Clear intervals
    this.toggleSyncOnSave(false);
    this.toggleSyncOnRemote(false);
    this.toggleStatusText(false);
    this.toggleStatusBar(false);
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
    if (this.settings.onedrive.clientID === "") {
      this.settings.onedrive.clientID = DEFAULT_SETTINGS.onedrive.clientID;
    }
    if (this.settings.onedrive.authority === "") {
      this.settings.onedrive.authority = DEFAULT_SETTINGS.onedrive.authority;
    }
    if (this.settings.onedrive.remoteBaseDir === undefined) {
      this.settings.onedrive.remoteBaseDir = "";
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
    if (this.settings.s3.disableS3MetadataSync == undefined) {
      this.settings.s3.disableS3MetadataSync = false;
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
    if (
      this.settings.onedrive.refreshToken !== "" &&
      this.settings.onedrive.credentialsShouldBeDeletedAtTime === undefined
    ) {
      this.settings.onedrive.credentialsShouldBeDeletedAtTime =
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

    let onedriveExpired = false;
    if (
      this.settings.onedrive.refreshToken !== "" &&
      current >= this.settings.onedrive.credentialsShouldBeDeletedAtTime
    ) {
      onedriveExpired = true;
      this.settings.onedrive = cloneDeep(DEFAULT_ONEDRIVE_CONFIG);
      needSave = true;
    }

    // save back
    if (needSave) {
      await this.saveSettings();
    }

    // send notice
    if (dropboxExpired && onedriveExpired) {
      new Notice(
        `${this.manifest.name}: You haven't manually auth Dropbox and OneDrive for a while, you need to re-auth them again.`,
        6000
      );
    } else if (dropboxExpired) {
      new Notice(
        `${this.manifest.name}: You haven't manually auth Dropbox for a while, you need to re-auth it again.`,
        6000
      );
    } else if (onedriveExpired) {
      new Notice(
        `${this.manifest.name}: You haven't manually auth OneDrive for a while, you need to re-auth it again.`,
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
    if (this.settings.trashLocal) {
      await this.app.vault.adapter.trashLocal(x);
      return;
    } else {
      // Attempt using system trash, if it fails fallback to trashing into .trash folder
      if (!(await this.app.vault.adapter.trashSystem(x))) {
        await this.app.vault.adapter.trashLocal(x);
      }
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

  // Needed to update text for get command
  toggleStatusText(enabled: boolean) {
    // Clears the current interval
    if (this.statusBarIntervalID !== undefined) {
      window.clearInterval(this.statusBarIntervalID);
      this.statusBarIntervalID = undefined;
    }

    // Set up interval
    if (enabled) {
      this.statusBarIntervalID = window.setInterval(async () => {
        if (this.syncStatus !== "syncing") {
          this.updateStatusBar();
        }
      }, 30_000);

      this.updateStatusBar();
    }
  }

  toggleStatusBar(enabled: boolean) {  
    const statusBar = document.getElementsByClassName("status-bar")[0];

    this.statusBarElement?.remove();

    // Show all default elements
    statusBar.childNodes.forEach((element) => {
      (element as HTMLElement).style.display = "flex";
    });

    // Enable status bar for mobile
    if (Platform.isMobile) {
      (statusBar as HTMLElement).style.display = enabled ? "flex" : "none";
    }

    if (enabled && this.settings.enableStatusBarInfo) {
      if (this.settings.showLastSyncedOnly)  {
        // Hide all default elements
        statusBar.childNodes.forEach((element) => {
          (element as HTMLElement).style.display = "none";
        });
      }

      this.statusBarElement = this.addStatusBarItem();
      this.statusBarElement.createEl("span");
      this.statusBarElement.setAttribute("data-tooltip-position", "top");    
      this.updateStatusBar(); 
    }
  }

  async toggleSyncOnRemote(enabled: boolean) {
    // Clears the current interval
    if (this.syncOnRemoteIntervalID !== undefined) {
      window.clearInterval(this.syncOnRemoteIntervalID);
      this.syncOnRemoteIntervalID = undefined;
    }

    if (enabled === false || this.settings.syncOnRemoteChangesAfterMilliseconds === -1) {
      return;
    }

    const syncOnRemote = async () => {
      if (this.syncStatus !== "idle") {
        return;
      }

      const metadataMtime = await this.getMetadataMtime();

      if (metadataMtime === undefined) {
        return false;
      }

      if (metadataMtime !== this.settings.lastSynced) {
        log.debug("Sync on Remote ran | Remote Metadata:", metadataMtime + ", Last Synced:", this.settings.lastSynced);
        this.syncRun("auto");
        return true;
      }
    };

    if (Platform.isMobileApp) {
      const onLoadResult = await syncOnRemote();
      new Notice(onLoadResult === true ? this.i18n.t("remote_changes_found") : this.i18n.t("remote_changes_synced"));
    }

    this.syncOnRemoteIntervalID = window.setInterval(syncOnRemote, this.settings.syncOnRemoteChangesAfterMilliseconds);
  }

  async toggleSyncOnSave(enabled: boolean) {
    let alreadyScheduled = false;

    // Unregister vault change event
    if (this.syncOnSaveEvent !== undefined) {
      this.app.vault.offref(this.syncOnSaveEvent);
      this.syncOnSaveEvent = undefined;
    }

    // Unregister scanning for .obsidian changes
    if (this.vaultScannerIntervalId !== undefined) {
      window.clearInterval(this.vaultScannerIntervalId);
      this.vaultScannerIntervalId = undefined;
    }

    if (enabled === false || this.settings.syncOnSaveAfterMilliseconds === -1) {
      return;
    }
    
    // Register vault change event
    this.syncOnSaveEvent = this.app.vault.on("modify", () => {
      if (this.syncStatus !== "idle" || alreadyScheduled) {
        return;
      }

      alreadyScheduled = true;
      log.debug(`Scheduled a sync run for ${this.settings.syncOnSaveAfterMilliseconds} milliseconds later`);

      setTimeout(async () => {
        log.debug("Sync on save ran");
        await this.syncRun("auto");  
        alreadyScheduled = false;
      }, this.settings.syncOnSaveAfterMilliseconds);
    });

    // Scan vault for config directory changes
    const scanVault = async () => {
      if (this.syncStatus !== "idle" || alreadyScheduled || !this.settings.syncConfigDir) {
        return;
      }

      log.debug("Scanning config directory for changes");

      let localConfigContents: ObsConfigDirFileType[] = await listFilesInObsFolder(this.app.vault, this.manifest.id, this.settings.syncTrash);

      for (let i = 0; i < localConfigContents.length; i++) {
        const file = localConfigContents[i];

        if (file.key.includes(".obsidian/plugins/remotely-secure/")) {
          continue;
        }

        if (file.mtime > this.settings.lastSynced) {
          log.debug("Unsynced config file found: ", file.key)
          alreadyScheduled = true;
          log.debug(`Scheduled a sync run for ${this.settings.syncOnSaveAfterMilliseconds} milliseconds later`);

          setTimeout(async () => {
            log.debug("Sync on save ran");
            await this.syncRun("auto");  
            alreadyScheduled = false;
          }, this.settings.syncOnSaveAfterMilliseconds);

          break;
        }
      }
    }

    // Scans every 60 seconds
    this.vaultScannerIntervalId = window.setInterval(scanVault, 30_000);
  }
  
  async getMetadataMtime() {
    const client = this.getRemoteClient(this);

    const remoteRsp = await client.listFromRemote();
    const {remoteStates, metadataFile} = await this.parseRemoteItems(remoteRsp.Contents, client);
    const metadataPath = await getMetadataPath(metadataFile, this.settings.password);

    if (metadataPath == undefined) {
      return undefined;
    }
    
    return (await client.getMetadataFromRemote(metadataPath)).lastModified;
  }

  private async getSyncPlan2() {
    // If we don't create trash folder and it's used it will result in an error.
    await this.createTrashIfDoesNotExist();
    const client = this.getRemoteClient(this);
    const remoteRsp = await client.listFromRemote();

    const passwordCheckResult = await isPasswordOk(
      remoteRsp.Contents,
      this.settings.password
    );
    const {remoteStates, metadataFile} = await this.parseRemoteItems(remoteRsp.Contents, client);

    const local = this.app.vault.getAllLoadedFiles();
    const localHistory = await this.getLocalHistory();
    let localConfigDirContents: ObsConfigDirFileType[] = await listFilesInObsFolder(this.app.vault, this.manifest.id, this.settings.syncTrash);
    const origMetadataOnRemote = await this.fetchMetadataFromRemote(metadataFile, client);


    const {
      plan
    } = await this.getSyncPlan(remoteStates, local, localConfigDirContents, origMetadataOnRemote, localHistory, client, "auto");
    return plan;
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

  private async createTrashFolderIfDoesNotExist(vault: Vault) {
    let trashStat = await vault.adapter.stat('.trash');
    if (trashStat == null) {
      await vault.adapter.mkdir('.trash');
    }
  }
}
