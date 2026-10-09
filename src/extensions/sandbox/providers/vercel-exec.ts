/** Installed through the file API, not an image change or a runtime-relative source file. */
export const execHelperPath = '/tmp/clanker-exec-v1.sh'
export const execHelper = `#!/bin/bash
echo $$ > "$1" || exit 1
set -o pipefail
/bin/bash -c "$3" 2>&1 | (ulimit -f 131072; exec tee -- "$2")
exit $?
`

/** One small, fixed cleanup command remains usable even after the shell clears /tmp. */
export const cleanupScript = `if read -r pid 2>/dev/null < "$1"; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
rm -f -- "$1" || exit $?
if [ "$3" != keep ]; then rm -f -- "$2"; fi`
