import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import * as fs from "fs";
import {
  decryptArrayBuffer,
  decryptBase32ToString,
  encryptArrayBuffer,
  encryptStringToBase32,
  encryptStringToBase64url,
  getSizeFromEncToOrig,
  getSizeFromOrigToEnc,
} from "../src/encrypt";
import { base64ToBase64url, bufferToArrayBuffer } from "../src/misc";

chai.use(chaiAsPromised);
const expect = chai.expect;

describe("Encryption tests", () => {
  beforeEach(function () {
    global.window = {
      crypto: require("crypto").webcrypto,
    } as any;
  });

  it("should encrypt string", async () => {
    const k = "dkjdhkfhdkjgsdklxxd";
    const password = "hey";
    expect(await encryptStringToBase32(k, password)).to.not.equal(k);
  });

  it("should raise error using different password", async () => {
    const k = "secret text";
    const password = "hey";
    const password2 = "hey2";
    const enc = await encryptStringToBase32(k, password);
    await expect(decryptBase32ToString(enc, password2)).to.be.rejected;
  });

  it("should encrypt and decrypt string and get the same result returned", async () => {
    const k = "jfkkjkjbce7983ycdeknkkjckooAIUHIDIBIE((*BII)njD/d/dd/d/sjxhux";
    const password = "hfiuibec989###oiu982bj1`";
    const enc = await encryptStringToBase32(k, password);
    // console.log(enc);
    const dec = await decryptBase32ToString(enc, password);
    // console.log(dec);
    expect(dec).equal(k);
  });

  it("should get size from origin to encrypted correctly", () => {
    expect(() => getSizeFromOrigToEnc(-1)).to.throw();
    expect(() => getSizeFromOrigToEnc(0.5)).to.throw();
    expect(getSizeFromOrigToEnc(0)).equals(32);
    expect(getSizeFromOrigToEnc(15)).equals(32);
    expect(getSizeFromOrigToEnc(16)).equals(48);
    expect(getSizeFromOrigToEnc(31)).equals(48);
    expect(getSizeFromOrigToEnc(32)).equals(64);
    expect(getSizeFromOrigToEnc(14787203)).equals(14787232);
  });

  it("should get size from encrypted to origin correctly", () => {
    expect(() => getSizeFromEncToOrig(-1)).to.throw();
    expect(() => getSizeFromEncToOrig(30)).to.throw();

    expect(getSizeFromEncToOrig(32)).to.deep.equal({
      minSize: 0,
      maxSize: 15,
    });
    expect(getSizeFromEncToOrig(48)).to.deep.equal({
      minSize: 16,
      maxSize: 31,
    });

    expect(() => getSizeFromEncToOrig(14787231)).to.throw();

    let { minSize, maxSize } = getSizeFromEncToOrig(14787232);
    expect(minSize <= 14787203 && 14787203 <= maxSize).to.be.true;
  });
});
