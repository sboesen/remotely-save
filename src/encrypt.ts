import { base32, base64url } from "rfc4648";
import { bufferToArrayBuffer, hexStringToTypedArray } from "./misc";

import { log } from "./moreOnLog";

const DEFAULT_ITER = 20000;

const getKeyFromPassword = async (
  salt: Uint8Array,
  password: string,
  rounds: number = DEFAULT_ITER
) => {
  const k1 = await window.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey", "deriveBits"]
  );

  const k2 = await window.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: rounds,
      hash: "SHA-256",
    },
    k1,
    256
  );

  return k2;
};

export const encryptArrayBuffer = async (
  arrBuf: ArrayBuffer,
  password: string,
  rounds: number = DEFAULT_ITER
) => {
  let salt = window.crypto.getRandomValues(new Uint8Array(16));

  const derivedKey = await getKeyFromPassword(salt, password, rounds);
  // 12 bytes or 96 bits per GCM spec https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  log.error("Encrypt-salt: ", bufferToArrayBuffer(salt));
  log.error("Encrypt-iv: ", bufferToArrayBuffer(iv));

  const keyCrypt = await window.crypto.subtle.importKey(
    "raw",
    derivedKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  log.error("Encrypt-Key: ", derivedKey);

  const enc = (await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    keyCrypt,
    arrBuf
  )) as ArrayBuffer;
  log.error("Encryption successful.");

  const res = new Uint8Array([...salt, ...iv, ...new Uint8Array(enc)]);
  log.error("Encryption-ciphertext: ", enc);

  return bufferToArrayBuffer(res);
};

export const decryptArrayBuffer = async (
  arrBuf: ArrayBuffer,
  password: string,
  rounds: number = DEFAULT_ITER
) => {
  const salt = arrBuf.slice(0, 16); // first 16 bytes are salt
  const iv = arrBuf.slice(16, 28); // next 12 bytes are IV
  const cipherText = arrBuf.slice(28); // final bytes are ciphertext
  log.error(arrBuf);
  log.error("arrbuf ^ next salt, iv, ciphertext");
  log.error(salt);
  log.error(iv);
  log.error(cipherText);
  const key = await getKeyFromPassword(
    new Uint8Array(salt),
    password,
    rounds
  );
  log.error("decKey", key);

  const keyCrypt = await window.crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );

  log.error("imported key");
  const dec = (await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    keyCrypt,
    cipherText
  )) as ArrayBuffer;
  log.error("decrypted");

  return dec;
};

export const encryptStringToBase32 = async (
  text: string,
  password: string,
  rounds: number = DEFAULT_ITER
) => {
  const enc = await encryptArrayBuffer(
    bufferToArrayBuffer(new TextEncoder().encode(text)),
    password,
    rounds
  );
  return base32.stringify(new Uint8Array(enc), { pad: false });
};

export const decryptBase32ToString = async (
  text: string,
  password: string,
  rounds: number = DEFAULT_ITER
) => {
  return new TextDecoder().decode(
    await decryptArrayBuffer(
      bufferToArrayBuffer(base32.parse(text, { loose: true })),
      password,
      rounds
    )
  );
};

export const encryptStringToBase64url = async (
  text: string,
  password: string,
  rounds: number = DEFAULT_ITER
) => {
  const enc = await encryptArrayBuffer(
    bufferToArrayBuffer(new TextEncoder().encode(text)),
    password,
    rounds
  );
  return base64url.stringify(new Uint8Array(enc), { pad: false });
};

export const decryptBase64urlToString = async (
  text: string,
  password: string,
  rounds: number = DEFAULT_ITER
) => {
  return new TextDecoder().decode(
    await decryptArrayBuffer(
      bufferToArrayBuffer(base64url.parse(text, { loose: true })),
      password,
      rounds
    )
  );
};

export const getSizeFromOrigToEnc = (x: number) => {
  if (x < 0 || Number.isNaN(x) || !Number.isInteger(x)) {
    throw Error(`getSizeFromOrigToEnc: x=${x} is not a valid size`);
  }
  return (Math.floor(x / 16) + 1) * 16 + 16;
};

export const getSizeFromEncToOrig = (x: number) => {
  if (x < 32 || Number.isNaN(x) || !Number.isInteger(x)) {
    throw Error(`getSizeFromEncToOrig: ${x} is not a valid size`);
  }
  if (x % 16 !== 0) {
    throw Error(
      `getSizeFromEncToOrig: ${x} is not a valid encrypted file size`
    );
  }
  return {
    minSize: ((x - 16) / 16 - 1) * 16,
    maxSize: ((x - 16) / 16 - 1) * 16 + 15,
  };
};
