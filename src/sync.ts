import {
  TAbstractFile,
  TFile,
  TFolder,
  Vault,
  requireApiVersion,
} from "obsidian";
import AggregateError from "aggregate-error";
import PQueue from "p-queue";
import type {
  RemoteItem,
  SyncTriggerSourceType,
  DecisionType,
  FileOrFolderMixedState,
  SUPPORTED_SERVICES_TYPE, RemotelySavePluginSettings,
} from "./baseTypes";
import { API_VER_STAT_FOLDER } from "./baseTypes";
import {
  decryptBase32ToString,
  decryptBase64urlToString,
  encryptStringToBase64url,
  getSizeFromOrigToEnc,
} from "./encrypt";
import type { FileFolderHistoryRecord, InternalDBs } from "./localdb";
import {
  clearDeleteRenameHistoryOfKeyAndVault,
  getSyncMetaMappingByRemoteKeyAndVault,
  upsertSyncMetaMappingDataByVault,
} from "./localdb";
import {
  isHiddenPath,
  mkdirpInVault,
  getFolderLevels,
  getParentFolder,
  atWhichLevel,
  unixTimeToStr,
  statFix,
} from "./misc";
import { RemoteClient } from "./remote";
import {
  MetadataOnRemote,
  DeletionOnRemote,
  serializeMetadataOnRemote,
  deserializeMetadataOnRemote,
  DEFAULT_FILE_NAME_FOR_METADATAONREMOTE,
  DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2,
  FILE_NAME_FOR_BOOKMARK_FILE,
  isEqualMetadataOnRemote, FILE_NAME_FOR_DATA_JSON, FileOnRemote,
} from "./metadataOnRemote";
import {isInsideObsFolder, isInsideTrashFolder, ObsConfigDirFileType} from "./obsFolderLister";

import { log } from "./moreOnLog";

export type SyncStatusType =
  | "idle"
  | "preparing"
  | "getting_remote_files_list"
  | "getting_remote_extra_meta"
  | "getting_local_meta"
  | "checking_password"
  | "generating_plan"
  | "syncing"
  | "cleaning"
  | "finish";

export interface SyncPlanType {
  ts: number;
  tsFmt?: string;
  syncTriggerSource?: SyncTriggerSourceType;
  remoteType: SUPPORTED_SERVICES_TYPE;
  mixedStates: Record<string, FileOrFolderMixedState>;
}

export interface PasswordCheckType {
  ok: boolean;
  reason:
    | "ok"
    | "empty_remote"
    | "password_matched"
    | "password_not_matched"
    | "invalid_text_after_decryption"
    | "remote_not_encrypted_local_has_password"
    | "no_password_both_sides";
}

export const isPasswordOk = async (
  remote: RemoteItem[],
  password: string = ""
) => {
  if (remote === undefined || remote.length === 0) {
    // remote empty
    return {
      ok: true,
      reason: "empty_remote",
    } as PasswordCheckType;
  }

  const sanityCheckKey = remote[0].key;
  // Check if metadata is stored unencrypted if the password is blank
  log.debug("password is blank? ", password == "", " remote has metadata? ", remote.some(item => item.key ==  '_remotely-secure-metadata-on-remote.json'));
  if (password == "" && remote.some(item => item.key ==  '_remotely-secure-metadata-on-remote.json')) {
    return {
      ok: true,
      reason: "no_password_both_sides"
    } as PasswordCheckType;
  }
  try {
    const res = await decryptBase64urlToString(sanityCheckKey, password);

    return {
      ok: true,
      reason: "password_matched",
    } as PasswordCheckType;
  } catch (error) {
    return {
      ok: false,
      reason: "password_not_matched",
    } as PasswordCheckType;
  }
};

export const getMetadataFiles = async(
  remote: RemoteItem[],
  password: string = ""
)=> {
  let metadataFiles = [];
  for (const entry of remote) {
    const remoteEncryptedKey = entry.key;
    let key = remoteEncryptedKey;
    if (password !== "") {
      key = await decryptBase64urlToString(remoteEncryptedKey, password);
    }
    if (key == DEFAULT_FILE_NAME_FOR_METADATAONREMOTE) {
      metadataFiles.push(remoteEncryptedKey);
    }
  }
  return metadataFiles;
}

export const parseRemoteItems = async (
  remote: RemoteItem[],
  db: InternalDBs,
  vaultRandomID: string,
  remoteType: SUPPORTED_SERVICES_TYPE,
  password: string = ""
) => {
  const remoteStates = [] as FileOrFolderMixedState[];
  let metadataFile: FileOrFolderMixedState = undefined;
  if (remote === undefined) {
    return {
      remoteStates: remoteStates,
      metadataFile: metadataFile,
    };
  }

  for (const entry of remote) {
    const remoteEncryptedKey = entry.key;
    let key = remoteEncryptedKey;
    if (password !== "") {
      key = await decryptBase64urlToString(remoteEncryptedKey, password);
    }
    const backwardMapping = await getSyncMetaMappingByRemoteKeyAndVault(
      remoteType,
      db,
      key,
      entry.lastModified,
      entry.etag,
      vaultRandomID
    );

    let r = {} as FileOrFolderMixedState;
    if (backwardMapping !== undefined) {
      key = backwardMapping.localKey;
      const mtimeRemote = backwardMapping.localMtime || entry.lastModified;

      // the backwardMapping.localSize is the file BEFORE encryption
      // we want to split two sizes for comparation later

      r = {
        key: key,
        existRemote: true,
        mtimeRemote: mtimeRemote,
        mtimeRemoteFmt: unixTimeToStr(mtimeRemote),
        sizeRemote: backwardMapping.localSize,
        sizeRemoteEnc: password === "" ? undefined : entry.size,
        remoteEncryptedKey: remoteEncryptedKey,
        changeRemoteMtimeUsingMapping: true,
      };
    } else {
      // do not have backwardMapping
      r = {
        key: key,
        existRemote: true,
        mtimeRemote: entry.lastModified,
        mtimeRemoteFmt: unixTimeToStr(entry.lastModified),
        sizeRemote: password === "" ? entry.size : undefined,
        sizeRemoteEnc: password === "" ? undefined : entry.size,
        remoteEncryptedKey: remoteEncryptedKey,
        changeRemoteMtimeUsingMapping: false,
      };
    }

    if (r.key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE) {
      metadataFile = Object.assign({}, r);
    }
    if (r.key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2) {
      throw Error(
        `A reserved file name ${r.key} has been found. You may upgrade the plugin to latest version to try to deal with it.`
      );
    }

    remoteStates.push(r);
  }
  return {
    remoteStates: remoteStates,
    metadataFile: metadataFile,
  };
};

export const fetchMetadataFile = async (
  metadataFile: FileOrFolderMixedState,
  client: RemoteClient,
  vault: Vault,
  password: string = ""
) => {
  if (metadataFile === undefined) {
    log.debug("no metadata file, so no fetch");
    return {
      deletions: [],
    } as MetadataOnRemote;
  }

  const buf = await client.downloadFromRemote(
    metadataFile.key,
    vault,
    metadataFile.mtimeRemote,
    password,
    metadataFile.remoteEncryptedKey,
    true
  );
  const metadata = deserializeMetadataOnRemote(buf);
  return metadata;
};

const isSkipItem = (
  key: string,
  syncConfigDir: boolean,
  syncUnderscoreItems: boolean,
  syncTrashDir: boolean,
  syncBookmarks: boolean
  , configDir: string) => {
  if (syncConfigDir && isInsideObsFolder(key, configDir)) {
    // Special exception for Remotely Sync's data.json file - always skip.
    // No point to sync our plugin settings, causes endless syncing because we persist last sync time
    if (key == configDir + '/plugins/remotely-secure/' + FILE_NAME_FOR_DATA_JSON) {
      return true;
    }
    return false;
  }

  if (syncTrashDir && isInsideTrashFolder(key)) {
    return true;
  }

  const shouldSkip = (
    isHiddenPath(key, true, false) ||
    (!syncUnderscoreItems && isHiddenPath(key, false, true)) ||
    key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE ||
    key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2
  );
  // Special exception for bookmark file, don't skip.
  if (key === configDir + FILE_NAME_FOR_BOOKMARK_FILE) {
    return false;
  }
  return shouldSkip;


};

const ensembleMixedStates = async (
  remoteStates: FileOrFolderMixedState[],
  local: TAbstractFile[],
  localConfigDirContents: ObsConfigDirFileType[] | undefined,
  remoteDeleteHistory: DeletionOnRemote[],
  localFileHistory: FileFolderHistoryRecord[],
  settings: RemotelySavePluginSettings,
  configDir: string,
  syncUnderscoreItems: boolean,
  password: string
) => {
  const results = {} as Record<string, FileOrFolderMixedState>;

  for (const r of remoteStates) {
    const key = r.key;

    if (isSkipItem(key, settings.syncConfigDir, syncUnderscoreItems, settings.syncTrash, settings.syncBookmarks, configDir)) {
      continue;
    }
    results[key] = r;
    results[key].existLocal = false;
  }

  for (const entry of local) {
    let r = {} as FileOrFolderMixedState;
    let key = entry.path;

    if (entry.path === "/") {
      // ignore
      continue;
    } else if (entry instanceof TFile) {
      const mtimeLocal = Math.max(entry.stat.mtime ?? 0, entry.stat.ctime ?? 0);
      r = {
        key: entry.path,
        existLocal: true,
        mtimeLocal: mtimeLocal,
        mtimeLocalFmt: unixTimeToStr(mtimeLocal),
        sizeLocal: entry.stat.size,
        sizeLocalEnc:
          password === "" ? undefined : getSizeFromOrigToEnc(entry.stat.size),
      };
    } else if (entry instanceof TFolder) {
      key = `${entry.path}/`;
      r = {
        key: key,
        existLocal: true,
        mtimeLocal: undefined,
        mtimeLocalFmt: undefined,
        sizeLocal: 0,
        sizeLocalEnc: password === "" ? undefined : getSizeFromOrigToEnc(0),
      };
    } else {
      throw Error(`unexpected ${entry}`);
    }

    if (isSkipItem(key, settings.syncConfigDir, syncUnderscoreItems, settings.syncTrash, settings.syncBookmarks, configDir)) {
      continue;
    }

    if (results.hasOwnProperty(key)) {
      results[key].key = r.key;
      results[key].existLocal = r.existLocal;
      results[key].mtimeLocal = r.mtimeLocal;
      results[key].mtimeLocalFmt = r.mtimeLocalFmt;
      results[key].sizeLocal = r.sizeLocal;
      results[key].sizeLocalEnc = r.sizeLocalEnc;
    } else {
      results[key] = r;
      results[key].existRemote = false;
    }
  }

  if (localConfigDirContents !== undefined) {
    for (const entry of localConfigDirContents) {
      const key = entry.key;
      // If we're not syncing the config dir and it isn't the bookmark file, skip.
      if (!settings.syncConfigDir && key != configDir + FILE_NAME_FOR_BOOKMARK_FILE) {
        continue;
      }
      let mtimeLocal = Math.max(entry.mtime ?? 0, entry.ctime ?? 0);
      if (Number.isNaN(mtimeLocal) || mtimeLocal === 0) {
        mtimeLocal = undefined;
      }
      const r: FileOrFolderMixedState = {
        key: key,
        existLocal: true,
        mtimeLocal: mtimeLocal,
        mtimeLocalFmt: unixTimeToStr(mtimeLocal),
        sizeLocal: entry.size,
        sizeLocalEnc:
          password === "" ? undefined : getSizeFromOrigToEnc(entry.size),
      };

      if (results.hasOwnProperty(key)) {
        results[key].key = r.key;
        results[key].existLocal = r.existLocal;
        results[key].mtimeLocal = r.mtimeLocal;
        results[key].mtimeLocalFmt = r.mtimeLocalFmt;
        results[key].sizeLocal = r.sizeLocal;
        results[key].sizeLocalEnc = r.sizeLocalEnc;
      } else {
        results[key] = r;
        results[key].existRemote = false;
      }
    }
  }

  for (const entry of remoteDeleteHistory) {
    const key = entry.key;
    const r = {
      key: key,
      deltimeRemote: entry.actionWhen,
      deltimeRemoteFmt: unixTimeToStr(entry.actionWhen),
    } as FileOrFolderMixedState;

    if (isSkipItem(key, settings.syncConfigDir, syncUnderscoreItems, settings.syncTrash, settings.syncBookmarks, configDir)) {
      continue;
    }

    if (results.hasOwnProperty(key)) {
      results[key].key = r.key;
      results[key].deltimeRemote = r.deltimeRemote;
      results[key].deltimeRemoteFmt = r.deltimeRemoteFmt;
    } else {
      results[key] = r;

      results[key].existLocal = false;
      results[key].existRemote = false;
    }
  }

  for (const entry of localFileHistory) {
    let key = entry.key;
    if (entry.keyType === "folder") {
      if (!entry.key.endsWith("/")) {
        key = `${entry.key}/`;
      }
    } else if (entry.keyType === "file") {
      // pass
    } else {
      throw Error(`unexpected ${entry}`);
    }

    if (isSkipItem(key, settings.syncConfigDir, syncUnderscoreItems, settings.syncTrash, settings.syncBookmarks, configDir)) {
      continue;
    }

    if (entry.actionType === "delete" || entry.actionType === "rename") {
      const r = {
        key: key,
        deltimeLocal: entry.actionWhen,
        deltimeLocalFmt: unixTimeToStr(entry.actionWhen),
      } as FileOrFolderMixedState;

      if (results.hasOwnProperty(key)) {
        results[key].deltimeLocal = r.deltimeLocal;
        results[key].deltimeLocalFmt = r.deltimeLocalFmt;
      } else {
        results[key] = r;
        results[key].existLocal = false; // we have already checked local
        results[key].existRemote = false; // we have already checked remote
      }
    } else if (entry.actionType === "renameDestination") {
      const r = {
        key: key,
        mtimeLocal: entry.actionWhen,
        mtimeLocalFmt: unixTimeToStr(entry.actionWhen),
        changeLocalMtimeUsingMapping: true,
      };
      if (results.hasOwnProperty(key)) {
        let mtimeLocal = Math.max(
          r.mtimeLocal ?? 0,
          results[key].mtimeLocal ?? 0
        );
        if (Number.isNaN(mtimeLocal) || mtimeLocal === 0) {
          mtimeLocal = undefined;
        }
        results[key].mtimeLocal = mtimeLocal;
        results[key].mtimeLocalFmt = unixTimeToStr(mtimeLocal);
        results[key].changeLocalMtimeUsingMapping =
          r.changeLocalMtimeUsingMapping;
      } else {
        // So, the file doesn't exist,
        // except that it existed in the "renamed to" history records.
        // Most likely because that the user deleted the file while Obsidian was closed,
        // so Obsidian could not track the deletions.
        // We are not sure how to deal with this, so do not generate anything here!
        // // // The following 3 lines are of old logic, and have been removed:
        // // results[key] = r;
        // // results[key].existLocal = false; // we have already checked local
        // // results[key].existRemote = false; // we have already checked remote
      }
    } else {
      throw Error(
        `do not know how to deal with local file history ${entry.key} with ${entry.actionType}`
      );
    }
  }

  return results;
};

const assignOperationToFileInplace = (
  origRecord: FileOrFolderMixedState,
  keptFolder: Set<string>,
  remoteFiles: FileOnRemote[],
  skipSizeLargerThan: number,
  password: string = "",
  checkFileHashes: boolean
) => {
  let r = origRecord;

  // files and folders are treated differently
  // here we only check files
  if (r.key.endsWith("/")) {
    return r;
  }

  // we find the max date from four sources

  // 0. find anything inconsistent
  if (r.existLocal && (r.mtimeLocal === undefined || r.mtimeLocal <= 0)) {
    throw Error(
      `Error: Abnormal last modified time locally: ${JSON.stringify(
        r,
        null,
        2
      )}`
    );
  }
  if (r.existRemote && (r.mtimeRemote === undefined || r.mtimeRemote <= 0)) {
    throw Error(
      `Error: Abnormal last modified time remotely: ${JSON.stringify(
        r,
        null,
        2
      )}`
    );
  }
  if (r.deltimeLocal !== undefined && r.deltimeLocal <= 0) {
    throw Error(
      `Error: Abnormal deletion time locally: ${JSON.stringify(r, null, 2)}`
    );
  }
  if (r.deltimeRemote !== undefined && r.deltimeRemote <= 0) {
    throw Error(
      `Error: Abnormal deletion time remotely: ${JSON.stringify(r, null, 2)}`
    );
  }

  if (
    (r.existLocal && password !== "" && r.sizeLocalEnc === undefined) ||
    (r.existRemote && password !== "" && r.sizeRemoteEnc === undefined)
  ) {
    throw new Error(
      `Error: No encryption sizes: ${JSON.stringify(r, null, 2)}`
    );
  }

  const sizeLocalComp = password === "" ? r.sizeLocal : r.sizeLocalEnc;
  const sizeRemoteComp = password === "" ? r.sizeRemote : r.sizeRemoteEnc;

  // 1. mtimeLocal
  if (r.existLocal) {
    const mtimeRemote = r.existRemote ? r.mtimeRemote : -1;
    const deltimeRemote = r.deltimeRemote !== undefined ? r.deltimeRemote : -1;
    const deltimeLocal = r.deltimeLocal !== undefined ? r.deltimeLocal : -1;
    if (
      r.mtimeLocal >= mtimeRemote &&
      r.mtimeLocal >= deltimeLocal &&
      r.mtimeLocal >= deltimeRemote
    ) {
      if (sizeLocalComp === undefined) {
        throw new Error(
          `Error: no local size but has local mtime: ${JSON.stringify(
            r,
            null,
            2
          )}`
        );
      }
      if (r.mtimeLocal === r.mtimeRemote) {
        // local and remote both exist and mtimes are the same
        if (sizeLocalComp === sizeRemoteComp) {
          // do not need to consider skipSizeLargerThan in this case
          r.decision = "skipUploading";
          r.decisionBranch = 1;
        } else {
          if (skipSizeLargerThan <= 0) {
            r.decision = "uploadLocalToRemote";
            r.decisionBranch = 2;
          } else {
            // limit the sizes
            if (sizeLocalComp <= skipSizeLargerThan) {
              if (sizeRemoteComp <= skipSizeLargerThan) {
                r.decision = "uploadLocalToRemote";
                r.decisionBranch = 18;
              } else {
                r.decision = "errorRemoteTooLargeConflictLocal";
                r.decisionBranch = 19;
              }
            } else {
              if (sizeRemoteComp <= skipSizeLargerThan) {
                r.decision = "errorLocalTooLargeConflictRemote";
                r.decisionBranch = 20;
              } else {
                r.decision = "skipUploadingTooLarge";
                r.decisionBranch = 21;
              }
            }
          }
        }
      } else {
        // we have local largest mtime,
        // and the remote not existing or smaller mtime

        // TODO: Check file hash against hashes on remote
        if r.

        if (skipSizeLargerThan <= 0) {
          // no need to consider sizes
          r.decision = "uploadLocalToRemote";
          r.decisionBranch = 4;
        } else {
          // need to consider sizes
          if (sizeLocalComp <= skipSizeLargerThan) {
            if (sizeRemoteComp === undefined) {
              r.decision = "uploadLocalToRemote";
              r.decisionBranch = 22;
            } else if (sizeRemoteComp <= skipSizeLargerThan) {
              r.decision = "uploadLocalToRemote";
              r.decisionBranch = 23;
            } else {
              r.decision = "errorRemoteTooLargeConflictLocal";
              r.decisionBranch = 24;
            }
          } else {
            if (sizeRemoteComp === undefined) {
              r.decision = "skipUploadingTooLarge";
              r.decisionBranch = 25;
            } else if (sizeRemoteComp <= skipSizeLargerThan) {
              r.decision = "errorLocalTooLargeConflictRemote";
              r.decisionBranch = 26;
            } else {
              r.decision = "skipUploadingTooLarge";
              r.decisionBranch = 27;
            }
          }
        }
      }
      keptFolder.add(getParentFolder(r.key));
      return r;
    }
  }

  // 2. mtimeRemote
  if (r.existRemote) {
    // TODO: Check if file hash matches remoteFiles.
    const mtimeLocal = r.existLocal ? r.mtimeLocal : -1;
    const deltimeRemote = r.deltimeRemote !== undefined ? r.deltimeRemote : -1;
    const deltimeLocal = r.deltimeLocal !== undefined ? r.deltimeLocal : -1;
    if (
      r.mtimeRemote > mtimeLocal &&
      r.mtimeRemote >= deltimeLocal &&
      r.mtimeRemote >= deltimeRemote
    ) {
      // we have remote laregest mtime,
      // and the local not existing or smaller mtime
      if (sizeRemoteComp === undefined) {
        throw new Error(
          `Error: no remote size but has remote mtime: ${JSON.stringify(
            r,
            null,
            2
          )}`
        );
      }

      if (skipSizeLargerThan <= 0) {
        // no need to consider sizes
        r.decision = "downloadRemoteToLocal";
        r.decisionBranch = 5;
      } else {
        // need to consider sizes
        if (sizeRemoteComp <= skipSizeLargerThan) {
          if (sizeLocalComp === undefined) {
            r.decision = "downloadRemoteToLocal";
            r.decisionBranch = 28;
          } else if (sizeLocalComp <= skipSizeLargerThan) {
            r.decision = "downloadRemoteToLocal";
            r.decisionBranch = 29;
          } else {
            r.decision = "errorLocalTooLargeConflictRemote";
            r.decisionBranch = 30;
          }
        } else {
          if (sizeLocalComp === undefined) {
            r.decision = "skipDownloadingTooLarge";
            r.decisionBranch = 31;
          } else if (sizeLocalComp <= skipSizeLargerThan) {
            r.decision = "errorRemoteTooLargeConflictLocal";
            r.decisionBranch = 32;
          } else {
            r.decision = "skipDownloadingTooLarge";
            r.decisionBranch = 33;
          }
        }
      }

      keptFolder.add(getParentFolder(r.key));
      return r;
    }
  }

  // 3. deltimeLocal
  if (r.deltimeLocal !== undefined && r.deltimeLocal !== 0) {
    const mtimeLocal = r.existLocal ? r.mtimeLocal : -1;
    const mtimeRemote = r.existRemote ? r.mtimeRemote : -1;
    const deltimeRemote = r.deltimeRemote !== undefined ? r.deltimeRemote : -1;
    if (
      r.deltimeLocal >= mtimeLocal &&
      r.deltimeLocal >= mtimeRemote &&
      r.deltimeLocal >= deltimeRemote
    ) {
      if (skipSizeLargerThan <= 0) {
        r.decision = "uploadLocalDelHistToRemote";
        r.decisionBranch = 6;
        if (r.existLocal || r.existRemote) {
          // actual deletion would happen
        }
      } else {
        const localTooLargeToDelete =
          r.existLocal && sizeLocalComp > skipSizeLargerThan;
        const remoteTooLargeToDelete =
          r.existRemote && sizeRemoteComp > skipSizeLargerThan;
        if (localTooLargeToDelete) {
          if (remoteTooLargeToDelete) {
            r.decision = "skipUsingLocalDelTooLarge";
            r.decisionBranch = 34;
          } else {
            if (r.existRemote) {
              r.decision = "errorLocalTooLargeConflictRemote";
              r.decisionBranch = 35;
            } else {
              r.decision = "skipUsingLocalDelTooLarge";
              r.decisionBranch = 36;
            }
          }
        } else {
          if (remoteTooLargeToDelete) {
            if (r.existLocal) {
              r.decision = "errorLocalTooLargeConflictRemote";
              r.decisionBranch = 37;
            } else {
              r.decision = "skipUsingLocalDelTooLarge";
              r.decisionBranch = 38;
            }
          } else {
            r.decision = "uploadLocalDelHistToRemote";
            r.decisionBranch = 39;
          }
        }
      }
      return r;
    }
  }

  // 4. deltimeRemote
  if (r.deltimeRemote !== undefined && r.deltimeRemote !== 0) {
    const mtimeLocal = r.existLocal ? r.mtimeLocal : -1;
    const mtimeRemote = r.existRemote ? r.mtimeRemote : -1;
    const deltimeLocal = r.deltimeLocal !== undefined ? r.deltimeLocal : -1;
    if (
      r.deltimeRemote >= mtimeLocal &&
      r.deltimeRemote >= mtimeRemote &&
      r.deltimeRemote >= deltimeLocal
    ) {
      if (skipSizeLargerThan <= 0) {
        r.decision = "keepRemoteDelHist";
        r.decisionBranch = 7;
        if (r.existLocal || r.existRemote) {
          // actual deletion would happen
        }
      } else {
        const localTooLargeToDelete =
          r.existLocal && sizeLocalComp > skipSizeLargerThan;
        const remoteTooLargeToDelete =
          r.existRemote && sizeRemoteComp > skipSizeLargerThan;
        if (localTooLargeToDelete) {
          if (remoteTooLargeToDelete) {
            r.decision = "skipUsingRemoteDelTooLarge";
            r.decisionBranch = 40;
          } else {
            if (r.existRemote) {
              r.decision = "errorLocalTooLargeConflictRemote";
              r.decisionBranch = 41;
            } else {
              r.decision = "skipUsingRemoteDelTooLarge";
              r.decisionBranch = 42;
            }
          }
        } else {
          if (remoteTooLargeToDelete) {
            if (r.existLocal) {
              r.decision = "errorLocalTooLargeConflictRemote";
              r.decisionBranch = 43;
            } else {
              r.decision = "skipUsingRemoteDelTooLarge";
              r.decisionBranch = 44;
            }
          } else {
            r.decision = "keepRemoteDelHist";
            r.decisionBranch = 45;
          }
        }
      }
      return r;
    }
  }

  throw Error(`no decision for ${JSON.stringify(r)}`);
};

const assignOperationToFolderInplace = async (
  origRecord: FileOrFolderMixedState,
  keptFolder: Set<string>,
  vault: Vault,
  password: string = ""
) => {
  let r = origRecord;

  // files and folders are treated differently
  // here we only check folders
  if (!r.key.endsWith("/")) {
    return r;
  }

  if (!keptFolder.has(r.key)) {
    // the folder does NOT have any must-be-kept children!

    if (r.deltimeLocal !== undefined || r.deltimeRemote !== undefined) {
      // it has some deletion "commands"

      const deltimeLocal = r.deltimeLocal !== undefined ? r.deltimeLocal : -1;
      const deltimeRemote =
        r.deltimeRemote !== undefined ? r.deltimeRemote : -1;

      // if it was created after deletion, we should keep it as is
      if (requireApiVersion(API_VER_STAT_FOLDER)) {
        if (r.existLocal) {
          const { ctime, mtime } = await statFix(vault, r.key);
          const cmtime = Math.max(ctime ?? 0, mtime ?? 0);
          if (
            !Number.isNaN(cmtime) &&
            cmtime > 0 &&
            cmtime >= deltimeLocal &&
            cmtime >= deltimeRemote
          ) {
            keptFolder.add(getParentFolder(r.key));
            if (r.existLocal && r.existRemote) {
              r.decision = "skipFolder";
              r.decisionBranch = 14;
            } else if (r.existLocal || r.existRemote) {
              r.decision = "createFolder";
              r.decisionBranch = 15;
            } else {
              throw Error(
                `Error: Folder ${r.key} doesn't exist locally and remotely but is marked must be kept. Abort.`
              );
            }
          }
        }
      }

      // If it was moved to here, after deletion, we should keep it as is.
      // The logic not necessarily needs API_VER_STAT_FOLDER.
      // The folder needs this logic because it's also determined by file children.
      // But the file do not need this logic because the mtimeLocal is checked firstly.
      if (
        r.existLocal &&
        r.changeLocalMtimeUsingMapping &&
        r.mtimeLocal > 0 &&
        r.mtimeLocal > deltimeLocal &&
        r.mtimeLocal > deltimeRemote
      ) {
        keptFolder.add(getParentFolder(r.key));
        if (r.existLocal && r.existRemote) {
          r.decision = "skipFolder";
          r.decisionBranch = 16;
        } else if (r.existLocal || r.existRemote) {
          r.decision = "createFolder";
          r.decisionBranch = 17;
        } else {
          throw Error(
            `Error: Folder ${r.key} doesn't exist locally and remotely but is marked must be kept. Abort.`
          );
        }
      }

      if (r.decision === undefined) {
        // not yet decided by the above reason
        if (deltimeLocal > 0 && deltimeLocal > deltimeRemote) {
          r.decision = "uploadLocalDelHistToRemoteFolder";
          r.decisionBranch = 8;
        } else {
          r.decision = "keepRemoteDelHistFolder";
          r.decisionBranch = 9;
        }
      }
    } else {
      // it does not have any deletion commands
      // keep it as is, and create it if necessary
      keptFolder.add(getParentFolder(r.key));
      if (r.existLocal && r.existRemote) {
        r.decision = "skipFolder";
        r.decisionBranch = 10;
      } else if (r.existLocal || r.existRemote) {
        r.decision = "createFolder";
        r.decisionBranch = 11;
      } else {
        throw Error(
          `Error: Folder ${r.key} doesn't exist locally and remotely but is marked must be kept. Abort.`
        );
      }
    }
  } else {
    // the folder has some must be kept children!
    // so itself and its parent folder must be kept
    keptFolder.add(getParentFolder(r.key));
    if (r.existLocal && r.existRemote) {
      r.decision = "skipFolder";
      r.decisionBranch = 12;
    } else if (r.existLocal || r.existRemote) {
      r.decision = "createFolder";
      r.decisionBranch = 13;
    } else {
      throw Error(
        `Error: Folder ${r.key} doesn't exist locally and remotely but is marked must be kept. Abort.`
      );
    }
  }

  // save the memory, save the world!
  // we have dealt with it, so we don't need it any more.
  keptFolder.delete(r.key);
  return r;
};

const DELETION_DECISIONS: Set<DecisionType> = new Set([
  "uploadLocalDelHistToRemote",
  "keepRemoteDelHist",
  "uploadLocalDelHistToRemoteFolder",
  "keepRemoteDelHistFolder",
]);
const SIZES_GO_WRONG_DECISIONS: Set<DecisionType> = new Set([
  "errorLocalTooLargeConflictRemote",
  "errorRemoteTooLargeConflictLocal",
]);

export const getSyncPlan = async (
  remoteStates: FileOrFolderMixedState[],
  local: TAbstractFile[],
  localConfigDirContents: ObsConfigDirFileType[] | undefined,
  remoteMetadata: MetadataOnRemote,
  localFileHistory: FileFolderHistoryRecord[],
  remoteType: SUPPORTED_SERVICES_TYPE,
  triggerSource: SyncTriggerSourceType,
  vault: Vault,
  settings: RemotelySavePluginSettings,
  configDir: string,
  syncUnderscoreItems: boolean,
  skipSizeLargerThan: number,
  password: string = ""
) => {
  const remoteDeleteHistory = remoteMetadata.deletions;
  const remoteFiles = remoteMetadata.filesOnRemote;
  const mixedStates = await ensembleMixedStates(
    remoteStates,
    local,
    localConfigDirContents,
    remoteDeleteHistory,
    localFileHistory,
    settings,
    configDir,
    syncUnderscoreItems,
    password
  );

  const sortedKeys = Object.keys(mixedStates).sort(
    (k1, k2) => k2.length - k1.length
  );

  const sizesGoWrong: FileOrFolderMixedState[] = [];
  const deletions: DeletionOnRemote[] = [];

  const keptFolder = new Set<string>();
  for (let i = 0; i < sortedKeys.length; ++i) {
    const key = sortedKeys[i];
    const val = mixedStates[key];

    if (key.endsWith("/")) {
      // decide some folders
      // because the keys are sorted by length
      // so all the children must have been shown up before in the iteration
      await assignOperationToFolderInplace(val, keptFolder, vault, password);
    } else {
      // get all operations of files
      // and at the same time get some helper info for folders
      assignOperationToFileInplace(
        val,
        keptFolder,
        remoteFiles,
        skipSizeLargerThan,
        password,
        settings.checkFileHashes
      );
    }

    if (SIZES_GO_WRONG_DECISIONS.has(val.decision)) {
      sizesGoWrong.push(val);
    }

    if (DELETION_DECISIONS.has(val.decision)) {
      if (val.decision === "uploadLocalDelHistToRemote") {
        deletions.push({
          key: key,
          actionWhen: val.deltimeLocal,
        });
      } else if (val.decision === "keepRemoteDelHist") {
        deletions.push({
          key: key,
          actionWhen: val.deltimeRemote,
        });
      } else if (val.decision === "uploadLocalDelHistToRemoteFolder") {
        deletions.push({
          key: key,
          actionWhen: val.deltimeLocal,
        });
      } else if (val.decision === "keepRemoteDelHistFolder") {
        deletions.push({
          key: key,
          actionWhen: val.deltimeRemote,
        });
      } else {
        throw Error(`do not know how to delete for decision ${val.decision}`);
      }
    }
  }

  const currTs = Date.now();
  const currTsFmt = unixTimeToStr(currTs);
  const plan = {
    ts: currTs,
    tsFmt: currTsFmt,
    remoteType: remoteType,
    syncTriggerSource: triggerSource,
    mixedStates: mixedStates,
  } as SyncPlanType;
  return {
    plan: plan,
    sortedKeys: sortedKeys,
    deletions: deletions,
    sizesGoWrong: sizesGoWrong,
  };
};

export const uploadExtraMeta = async (
  client: RemoteClient,
  vault: Vault,
  metadataFile: FileOrFolderMixedState | undefined,
  origMetadata: MetadataOnRemote | undefined,
  deletions: DeletionOnRemote[],
  filesOnRemote: FileOnRemote[],
  password: string = ""
) => {

  const key = DEFAULT_FILE_NAME_FOR_METADATAONREMOTE;
  let remoteEncryptedKey = key;

  if (password !== "") {
    if (metadataFile === undefined) {
      remoteEncryptedKey = undefined;
    } else {
      remoteEncryptedKey = metadataFile.remoteEncryptedKey;
    }
    if (remoteEncryptedKey === undefined || remoteEncryptedKey === "") {
      // remoteEncryptedKey = await encryptStringToBase32(key, password);
      remoteEncryptedKey = await encryptStringToBase64url(key, password);
    }
  }

  const newMetadata: MetadataOnRemote = {
    deletions: deletions,
    filesOnRemote: filesOnRemote,
  };

  // TODO: optimize and/or refactor this. Inefficient until user deletes a file
  if (origMetadata && origMetadata.deletions.length > 0 && isEqualMetadataOnRemote(origMetadata, newMetadata)) {
    log.debug(
      "metadata are the same, no need to re-generate and re-upload it."
    );
    return;
  }

  const resultText = serializeMetadataOnRemote(newMetadata);

  await client.uploadToRemote(
    key,
    vault,
    false,
    password,
    remoteEncryptedKey,
    undefined,
    true,
    resultText
  );
};

export const getMetadataPath = async (metadataFile: FileOrFolderMixedState | undefined, password: string = "") => {
  if (metadataFile === undefined) {
    log.debug("no metadata file, so no file path");
    return;
  }

  const key = DEFAULT_FILE_NAME_FOR_METADATAONREMOTE;
  let remoteEncryptedKey = key;

  if (password !== "") {
    remoteEncryptedKey = metadataFile.remoteEncryptedKey;

    if (remoteEncryptedKey === undefined || remoteEncryptedKey === "") {
      remoteEncryptedKey = await encryptStringToBase64url(key, password);
    }
  }

  return remoteEncryptedKey;
};

const dispatchOperationToActual = async (
  key: string,
  vaultRandomID: string,
  r: FileOrFolderMixedState,
  client: RemoteClient,
  db: InternalDBs,
  vault: Vault,
  localDeleteFunc: any,
  password: string = ""
) => {
  let remoteEncryptedKey = key;
  if (password !== "") {
    remoteEncryptedKey = r.remoteEncryptedKey;
    if (remoteEncryptedKey === undefined || remoteEncryptedKey === "") {
      // the old version uses base32
      // remoteEncryptedKey = await encryptStringToBase32(key, password);
      // the new version users base64url
      remoteEncryptedKey = await encryptStringToBase64url(key, password);
    }
  }

  if (r.decision === undefined) {
    throw Error(`unknown decision in ${JSON.stringify(r)}`);
  } else if (r.decision === "skipUploading") {
    // do nothing!
  } else if (r.decision === "uploadLocalDelHistToRemote") {
    if (r.existLocal) {
      await localDeleteFunc(r.key);
    }
    if (r.existRemote) {
      await client.deleteFromRemote(r.key, password, remoteEncryptedKey);
    }
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "keepRemoteDelHist") {
    if (r.existLocal) {
      await localDeleteFunc(r.key);
    }
    if (r.existRemote) {
      await client.deleteFromRemote(r.key, password, remoteEncryptedKey);
    }
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "uploadLocalToRemote") {
    if (
      client.serviceType === "onedrive" &&
      r.sizeLocal === 0 &&
      password === ""
    ) {
      // special treatment for empty files for OneDrive
      // TODO: it's ugly, any other way?
      // special treatment for OneDrive: do nothing, skip empty file without encryption
      // if it's empty folder, or it's encrypted file/folder, it continues to be uploaded.
    } else {
      const remoteObjMeta = await client.uploadToRemote(
        r.key,
        vault,
        false,
        password,
        remoteEncryptedKey
      );
      await upsertSyncMetaMappingDataByVault(
        client.serviceType,
        db,
        r.key,
        r.mtimeLocal,
        r.sizeLocal,
        r.key,
        remoteObjMeta.lastModified,
        remoteObjMeta.size,
        remoteObjMeta.etag,
        vaultRandomID
      );
    }
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "downloadRemoteToLocal") {
    await client.downloadFromRemote(
      r.key,
      vault,
      r.mtimeRemote,
      password,
      remoteEncryptedKey
    );
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "createFolder") {
    if (!r.existLocal) {
      await mkdirpInVault(r.key, vault);
    }
    if (!r.existRemote) {
      const remoteObjMeta = await client.uploadToRemote(
        r.key,
        vault,
        false,
        password,
        remoteEncryptedKey
      );
      await upsertSyncMetaMappingDataByVault(
        client.serviceType,
        db,
        r.key,
        r.mtimeLocal,
        r.sizeLocal,
        r.key,
        remoteObjMeta.lastModified,
        remoteObjMeta.size,
        remoteObjMeta.etag,
        vaultRandomID
      );
    }
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "uploadLocalDelHistToRemoteFolder") {
    if (r.existLocal) {
      await localDeleteFunc(r.key);
    }
    if (r.existRemote) {
      await client.deleteFromRemote(r.key, password, remoteEncryptedKey);
    }
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "keepRemoteDelHistFolder") {
    if (r.existLocal) {
      await localDeleteFunc(r.key);
    }
    if (r.existRemote) {
      await client.deleteFromRemote(r.key, password, remoteEncryptedKey);
    }
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "skipFolder") {
    // do nothing!
  } else if (r.decision === "skipUploadingTooLarge") {
    // do nothing!
  } else if (r.decision === "skipDownloadingTooLarge") {
    // do nothing!
  } else if (r.decision === "skipUsingLocalDelTooLarge") {
    // do nothing!
  } else if (r.decision === "skipUsingRemoteDelTooLarge") {
    // do nothing!
  } else {
    throw Error(`unknown decision in ${JSON.stringify(r)}`);
  }
};

const splitThreeSteps = (syncPlan: SyncPlanType, sortedKeys: string[]) => {
  const mixedStates = syncPlan.mixedStates;
  const totalCount = sortedKeys.length || 0;

  const folderCreationOps: FileOrFolderMixedState[][] = [];
  const deletionOps: FileOrFolderMixedState[][] = [];
  const uploadDownloads: FileOrFolderMixedState[][] = [];
  let realTotalCount = 0;

  for (let i = 0; i < sortedKeys.length; ++i) {
    const key = sortedKeys[i];
    const val: FileOrFolderMixedState = Object.assign({}, mixedStates[key]); // copy to avoid issue

    if (
      val.decision === "skipFolder" ||
      val.decision === "skipUploading" ||
      val.decision === "skipDownloadingTooLarge" ||
      val.decision === "skipUploadingTooLarge" ||
      val.decision === "skipUsingLocalDelTooLarge" ||
      val.decision === "skipUsingRemoteDelTooLarge"
    ) {
      // pass
    } else if (val.decision === "createFolder") {
      const level = atWhichLevel(key);
      if (level == undefined) {
        continue;
      }
      if (folderCreationOps[level - 1] === undefined) {
        folderCreationOps[level - 1] = [val];
      } else {
        folderCreationOps[level - 1].push(val);
      }
      realTotalCount += 1;
    } else if (
      val.decision === "uploadLocalDelHistToRemoteFolder" ||
      val.decision === "keepRemoteDelHistFolder" ||
      val.decision === "uploadLocalDelHistToRemote" ||
      val.decision === "keepRemoteDelHist"
    ) {
      const level = atWhichLevel(key);
      if (level == undefined) {
        continue;
      }
      if (deletionOps[level - 1] === undefined) {
        deletionOps[level - 1] = [val];
      } else {
        deletionOps[level - 1].push(val);
      }
      realTotalCount += 1;
    } else if (
      val.decision === "uploadLocalToRemote" ||
      val.decision === "downloadRemoteToLocal"
    ) {
      if (uploadDownloads.length === 0) {
        uploadDownloads[0] = [val];
      } else {
        uploadDownloads[0].push(val); // only one level needed here
      }
      realTotalCount += 1;
    } else {
      throw Error(`unknown decision ${val.decision} for ${key}`);
    }
  }

  // the deletionOps should be run from max level to min level
  // right now it is sorted by level from min to max (NOT length of key!)
  // so we need to reverse it!
  deletionOps.reverse(); // inplace reverse

  return {
    folderCreationOps: folderCreationOps,
    deletionOps: deletionOps,
    uploadDownloads: uploadDownloads,
    realTotalCount: realTotalCount,
  };
};

// Items worth reporting status for don't include skipped items or keepRemoteDelHist (one upload operation for all)
function isCountableSyncItem(item: FileOrFolderMixedState) {
  return item.decision != "keepRemoteDelHist" && !item.decision.contains("skip");
}

async function syncIndividualItem(key: string, val: FileOrFolderMixedState, vaultRandomID: string, client: RemoteClient, db: InternalDBs, vault: Vault, localDeleteFunc: any, password: string) {
  log.debug(`start syncing "${key}" with plan ${JSON.stringify(val)}`);

  await dispatchOperationToActual(
    key,
    vaultRandomID,
    val,
    client,
    db,
    vault,
    localDeleteFunc,
    password
  );
  log.debug(`finished ${key}`);
}

export const doActualSync = async (
  client: RemoteClient,
  db: InternalDBs,
  vaultRandomID: string,
  vault: Vault,
  syncPlan: SyncPlanType,
  sortedKeys: string[],
  metadataFile: FileOrFolderMixedState,
  origMetadata: MetadataOnRemote,
  sizesGoWrong: FileOrFolderMixedState[],
  deletions: DeletionOnRemote[],
  localDeleteFunc: any,
  password: string = "",
  concurrency: number = 1,
  callbackSizesGoWrong?: any,
  callbackSyncProcess?: any
) => {
  const mixedStates = syncPlan.mixedStates;

  if (sizesGoWrong.length > 0) {
    log.debug(`some sizes are larger than the threshold, abort and show hints`);
    callbackSizesGoWrong(sizesGoWrong);
    return;
  }

  log.debug(`concurrency === ${concurrency}`);
  if (concurrency === 1) {
    // run everything in sequence
    // good old way
    for (let i = 0; i < sortedKeys.length; ++i) {
      const key = sortedKeys[i];
      const val = mixedStates[key];

      await syncIndividualItem(key, val, vaultRandomID, client, db, vault, localDeleteFunc, password);
    }

    return; // shortcut return, avoid too many nests below
  }

  const { folderCreationOps, deletionOps, uploadDownloads, realTotalCount } =
    splitThreeSteps(syncPlan, sortedKeys);
  const nested = [folderCreationOps, deletionOps, uploadDownloads];
  const logTexts = [
    `1. create all folders from shadowest to deepest, also check undefined decision`,
    `2. delete files and folders from deepest to shadowest`,
    `3. upload or download files in parallel, with the desired concurrency=${concurrency}`,
  ];

  log.debug("folderCreationOps: ", folderCreationOps.length,
  " deletionOps: ", deletionOps.length,
  " uploadDownloads: ", uploadDownloads.length);

  for (let i = 0; i < nested.length; ++i) {
    log.debug(logTexts[i]);

    const operations: FileOrFolderMixedState[][] = nested[i];

    for (let j = 0; j < operations.length; ++j) {
      const singleLevelOps: FileOrFolderMixedState[] | undefined =
        operations[j];

      if (singleLevelOps === undefined || singleLevelOps === null) {
        continue;
      }

      const queue = new PQueue({ concurrency: concurrency, autoStart: true });
      const potentialErrors: Error[] = [];
      let tooManyErrors = false;

      for (let k = 0; k < singleLevelOps.length; ++k) {
        const val: FileOrFolderMixedState = singleLevelOps[k];
        const key = val.key;

        const fn = async () => {
          await syncIndividualItem(key, val, vaultRandomID, client, db, vault, localDeleteFunc, password);
        };

        queue.add(fn).catch((e) => {
          const msg = `${key}: ${e.message}`;
          potentialErrors.push(new Error(msg));
          if (potentialErrors.length >= 3) {
            tooManyErrors = true;
            queue.pause();
            queue.clear();
          }
        });
      }

      let queueSize = queue.size + queue.pending;
      queue.on('next', async () => {
        if (callbackSyncProcess !== undefined) {
          await callbackSyncProcess(queueSize - queue.pending, queueSize);
        }
      });
      await queue.onIdle();

        if (potentialErrors.length > 0) {
          if (tooManyErrors) {
            potentialErrors.push(
              new Error("too many errors, stop the remaining tasks")
            );
          }
          throw new AggregateError(potentialErrors);
        }

        log.debug(`start syncing extra data lastly`);
        await uploadExtraMeta(
          client,
          vault,
          metadataFile,
          origMetadata,
          deletions,
          filesOnRemote,
          password
        );
        log.debug(`finish syncing extra data`);
      }
  }
};
