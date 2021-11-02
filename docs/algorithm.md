# Algorithm

## Sources

We have three record sources:

1. Local files
2. Remote files
3. Local "delete-or-rename" history.

Assuming all sources are reliable.

## Deal with them

We list all combinations mutually exclusive and collectively exhaustive.

| ID  | Remote Files | Local files | Local delete rename history | Extra                                                      | Decision                                                                                          |
| --- | ------------ | ----------- | --------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | exist        | exist       | ignore                      | mtime_remote > mtime_local                                 | download remote file, create local folder if not exists, clear local history if exists            |
| 2   | exist        | exist       | ignore                      | mtime_remote < mtime_local                                 | upload local file, create remote folder if not exists, clear local history if exists              |
| 3   | exist        | exist       | ignore                      | mtime_remote === mtime_local && size_remote === size_local | clear local history if exists (the file was synced and no changes after last sync)                |
| 4   | exist        | exist       | ignore                      | mtime_remote === mtime_local && size_remote !== size_local | upload local file, clear local history if exists (we always prefer local to remote)               |
| 5   | exist        | exist       | ignore                      | If local is a folder. mtime_local === undefined            | clear local history if exists. TODO: what if a folder and a previous file share the same name?    |
| 6   | exist        | not exist   | exist                       | mtime_remote >= delete_time_local                          | download remote file, create folder if not exists                                                 |
| 7   | exist        | not exist   | exist                       | mtime_remote < delete_time_local                           | delete remote file, clear local history                                                           |
| 8   | exist        | not exist   | not exist                   |                                                            | download remote file, create folder if not exists                                                 |
| 9   | not exist    | exist       | ignore                      | If local is a single file.                                 | upload local file, create remote folder if not exists, clear local history if exists              |
| 10  | not exist    | exist       | ignore                      | If local is a folder.                                      | upload local files recursively, create remote folder if not exists, clear local history if exists |
| 11  | not exist    | not exist   | ignore                      |                                                            | clear local history if exists                                                                     |