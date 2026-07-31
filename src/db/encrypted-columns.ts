import { customType } from "drizzle-orm/sqlite-core";
import { decrypt, encrypt, isGcm } from "../utils/crypto";

function decryptCurrentOrPlaintext(value: string): string {
  return isGcm(value) ? decrypt(value) : value;
}

/** AES-GCM encrypted JSON that remains object-shaped at the ORM boundary. */
export const encryptedJson = customType<{ data: unknown; driverData: string }>({
  dataType: () => "text",
  toDriver(value) {
    return encrypt(JSON.stringify(value));
  },
  fromDriver(value) {
    return JSON.parse(decryptCurrentOrPlaintext(value));
  },
});

/** AES-GCM encrypted string that remains string-shaped at the ORM boundary. */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver(value) {
    return encrypt(value);
  },
  fromDriver(value) {
    return decryptCurrentOrPlaintext(value);
  },
});
