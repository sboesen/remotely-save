# Encryption

If a password is set, the files are encrypted before being sent to the cloud.

1. The encryption algorithm is implemented using web-crypto.
2. The file content is encrypted using using AES-GCM with a random IV.
3. The directory is considered as special "0-byte" object on remote s3. So this meta infomation may be easily guessed if some third party can access the remote bucket.
