export const maxStatusBytes = 64 * 1024
export const statusSocket = () => process.env.CLANKER_STATUS_SOCKET ?? `/tmp/clanker-status-${process.getuid!()}/status.sock`
