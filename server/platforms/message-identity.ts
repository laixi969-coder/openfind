export function xhsMessageDirection(
  messageId: string,
  accountId: string,
  peerId: string,
  me: boolean,
  other: boolean,
): 'incoming' | 'outgoing' {
  const [first, second, serverId, extra] = messageId.split('.');
  if (
    !serverId ||
    extra ||
    !((first === accountId && second === peerId) || (first === peerId && second === accountId))
  )
    throw new Error('消息不属于当前账号与会话，已暂停同步');
  if (me === other) throw new Error('无法核实消息方向，已暂停同步');
  return me ? 'outgoing' : 'incoming';
}

export function douyinPeer(nativeId: string, accountId: string) {
  const parts = nativeId.split(':');
  if (
    parts.length !== 4 ||
    parts[0] !== '0' ||
    parts[1] !== '1' ||
    !parts.slice(2).every((p) => /^\d+$/.test(p)) ||
    parts[2] === parts[3]
  )
    throw new Error('无法核实抖音单聊身份');
  if (parts[2] === accountId) return parts[3];
  if (parts[3] === accountId) return parts[2];
  throw new Error('会话不属于当前抖音账号');
}
export function douyinMessageDirection(
  nativeId: string,
  accountId: string,
  conversationId: string,
  sender: string,
  me: boolean,
  serverId: string,
) {
  const peer = douyinPeer(nativeId, accountId);
  if (
    conversationId !== nativeId ||
    !/^\d+$/.test(serverId) ||
    serverId === '0' ||
    ![accountId, peer].includes(sender) ||
    me !== (sender === accountId)
  )
    throw new Error('无法核实抖音消息身份或发送状态，已暂停同步');
  return me ? ('outgoing' as const) : ('incoming' as const);
}
