import isEqual from "lodash/isEqual";
import { base64url } from "rfc4648";
import { reverseString } from "./misc";
import { log } from "./moreOnLog";

const DEFAULT_README_FOR_METADATAONREMOTE =
  "Do NOT edit or delete the file manually. This file is for the plugin remotely-sync to store some necessary meta data on the remote services. Its content is slightly obfuscated.";

const DEFAULT_VERSION_FOR_METADATAONREMOTE = "20220220";

export const DEFAULT_FILE_NAME_FOR_METADATAONREMOTE =
  "_remotely-secure-metadata-on-remote.json";

export const DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2 =
  "_remotely-secure-metadata-on-remote.bin";

export const FILE_NAME_FOR_DATA_JSON =
  "data.json";

export const FILE_NAME_FOR_BOOKMARK_FILE =
  "/bookmarks.json";

export interface DeletionOnRemote {
  key: string;
  actionWhen: number;
}

export interface FileOnRemote {
  key: string;
  mtime: number;
  hash: string;
}

export interface MetadataOnRemote {
  version?: string;
  generatedWhen?: number;
  deletions?: DeletionOnRemote[];
  filesOnRemote?: FileOnRemote[];
}

export const isEqualMetadataOnRemote = (
  a: MetadataOnRemote,
  b: MetadataOnRemote
) => {
  const m1 = a === undefined ? { deletions: [], filesOnRemote: [] } : a;
  const m2 = b === undefined ? { deletions: [], filesOnRemote: [] } : b;

  // we only need to compare deletions
  const d1 = m1.deletions === undefined ? [] : m1.deletions;
  const d2 = m2.deletions === undefined ? [] : m2.deletions;

  // Compare files on remote.
  const f1 = m1.filesOnRemote == undefined ? [] : m1.filesOnRemote;
  const f2 = m2.filesOnRemote == undefined ? [] : m1.filesOnRemote;
  return isEqual(d1, d2) && isEqual(f1, f2);
};

export const serializeMetadataOnRemote = (x: MetadataOnRemote) => {
  const z = {
    readme: DEFAULT_README_FOR_METADATAONREMOTE,
    d: reverseString(
      base64url.stringify(Buffer.from(JSON.stringify(x), "utf-8"), {
        pad: false,
      })
    ),
  };

  return JSON.stringify(z, null, 2);
};

export const deserializeMetadataOnRemote = (x: string | ArrayBuffer) => {
  let y1 = "";
  if (typeof x === "string") {
    y1 = x;
  } else {
    y1 = new TextDecoder().decode(x);
  }

  let y2: any;
  try {
    y2 = JSON.parse(y1);
  } catch (e) {
    throw new Error(
      `invalid remote meta data file with first few chars: ${y1.slice(0, 5)}`
    );
  }

  if (!("readme" in y2 && "d" in y2)) {
    throw new Error(
      'invalid remote meta data file (no "readme" or "d" fields)!'
    );
  }

  let y3: string;
  try {
    y3 = (
      base64url.parse(reverseString(y2["d"]), {
        out: Buffer.allocUnsafe as any,
        loose: true,
      }) as Buffer
    ).toString("utf-8");
  } catch (e) {
    throw new Error('invalid remote meta data file (invalid "d" field)!');
  }

  let y4: MetadataOnRemote;
  try {
    y4 = JSON.parse(y3) as MetadataOnRemote;
  } catch (e) {
    throw new Error(
      `invalid remote meta data file with \"d\" field with first few chars: ${y3.slice(
        0,
        5
      )}`
    );
  }
  return y4;
};
