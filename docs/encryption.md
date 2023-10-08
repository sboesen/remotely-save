# Encryption

If a password is set, the files are encrypted before being sent to the cloud.

The encryption algorithm is delibrately designed to be aligned with openssl format.

1. The encryption algorithm is implemented using web-crypto.
2. The file content is encrypted using openssl format using AES-GCM with a random IV.

3. The file/directory path strings, are encrypted using openssl in binary mode and then `base64url without padding` is applied.

4. The directory is considered as special "0-byte" object on remote s3. So this meta infomation may be easily guessed if some third party can access the remote bucket.
