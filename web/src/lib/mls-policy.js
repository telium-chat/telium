// Group membership policy: a GroupContext extension every member checks, and the tree helpers that judge a commit against it.

import { defaultCapabilities } from 'ts-mls';
import { encode64 } from './mls-wire.js';

const te = new TextEncoder();
const td = new TextDecoder();

// Carried in a GroupContext extension so every member checks the same copy and no server can edit it. Type is in RFC 9420's private-use range.

export const POLICY_EXTENSION = 0xF7A0;

/// `admins` is the creator plus the admin list; `anyone` is no restriction.
export const POLICY_RULES = ['creator', 'admins', 'anyone'];

export function normalisePolicy(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.v !== 1 || typeof value.creator !== 'string' || !value.creator) return null;
  for (const rule of ['add', 'remove', 'policy']) {
    if (!POLICY_RULES.includes(value[rule])) return null;
  }
  const admins = Array.isArray(value.admins) ? value.admins : [];
  if (admins.length > 256 || admins.some((a) => typeof a !== 'string' || !a)) return null;
  return {
    v: 1,
    creator: value.creator,
    add: value.add,
    remove: value.remove,
    policy: value.policy,
    admins: [...new Set(admins)].sort(),
  };
}

export function policyAllows(policy, rule, userId) {
  if (!policy) return true;
  if (!userId) return false;
  const who = policy[rule];
  if (who === 'anyone') return true;
  if (userId === policy.creator) return true;
  return who === 'admins' && policy.admins.includes(userId);
}

export function samePolicy(a, b) {
  return JSON.stringify(normalisePolicy(a)) === JSON.stringify(normalisePolicy(b));
}

export function policyExtension(policy) {
  return { extensionType: POLICY_EXTENSION, extensionData: te.encode(JSON.stringify(policy)) };
}

export function isPolicyExtension(ext) {
  return ext && (ext.extensionType === POLICY_EXTENSION || Number(ext.extensionType) === POLICY_EXTENSION);
}

/// `null` when absent, `undefined` when present but unparseable.
export function policyIn(extensions) {
  const ext = (extensions || []).find(isPolicyExtension);
  if (!ext) return null;
  try { return normalisePolicy(JSON.parse(td.decode(ext.extensionData))) || undefined; }
  catch { return undefined; }
}

/// RFC 9420 requires all members to support a GroupContext extension, so groups containing older builds get no policy.
export function capabilities() {
  const base = defaultCapabilities();
  return { ...base, extensions: [...new Set([...(base.extensions || []), POLICY_EXTENSION])] };
}

function leafSupportsPolicy(leaf) {
  return (leaf?.capabilities?.extensions || []).includes(POLICY_EXTENSION);
}

export function supportsPolicy(keyPackage) {
  return leafSupportsPolicy(keyPackage?.leafNode);
}

export function leavesMissingPolicySupport(tree) {
  const out = new Set();
  for (const node of tree || []) {
    if (node?.nodeType !== 'leaf' || leafSupportsPolicy(node.leaf)) continue;
    const who = identityOf(node.leaf?.credential);
    out.add(who ? `${who.userId} (${who.deviceId})` : 'a device');
  }
  return [...out];
}

/// Leaf `n` is node `2n` in ts-mls's array tree.
export function leafIdentity(tree, leafIndex) {
  const node = (tree || [])[Number(leafIndex) * 2];
  if (!node || node.nodeType !== 'leaf') return null;
  return identityOf(node.leaf?.credential);
}

export function identityOf(credential) {
  if (credential?.credentialType !== 'basic') return null;
  const [userId, deviceId] = td.decode(credential.identity).split('|');
  return userId && deviceId ? { userId, deviceId } : null;
}

/// Read from the tree, which members agreed through signed commits, not from an envelope.
export function leafSignatureKey(tree, leafIndex) {
  const node = (tree || [])[Number(leafIndex) * 2];
  if (!node || node.nodeType !== 'leaf') return null;
  const key = node.leaf?.signaturePublicKey;
  return key ? new Uint8Array(key) : null;
}

export function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
}

export function externalJoiner(message) {
  if (message?.wireformat !== 'mls_public_message') return null;
  const content = message.publicMessage?.content;
  if (content?.sender?.senderType !== 'new_member_commit') return null;
  return identityOf(content.commit?.path?.leafNode?.credential)?.userId || null;
}

export function externalJoinerKey(message) {
  if (message?.wireformat !== 'mls_public_message') return null;
  const content = message.publicMessage?.content;
  if (content?.sender?.senderType !== 'new_member_commit') return null;
  const key = content.commit?.path?.leafNode?.signaturePublicKey;
  return key ? new Uint8Array(key) : null;
}

export function leavesOf(tree, userIds) {
  const out = [];
  (tree || []).forEach((node, index) => {
    if (index % 2 || node?.nodeType !== 'leaf') return;
    const who = identityOf(node.leaf?.credential);
    if (who && userIds.has(who.userId)) out.push(index / 2);
  });
  return out;
}

export function usersInTree(tree) {
  const out = new Set();
  for (const node of tree || []) {
    if (node?.nodeType !== 'leaf') continue;
    const who = identityOf(node.leaf?.credential);
    if (who) out.add(who.userId);
  }
  return out;
}

/// MLS identifies a leaf by signature key, and one key is reused across sign-ins with fresh device ids; counting device ids would build an invalid Add.
export function clientsInTree(tree) {
  const out = new Set();
  for (const node of tree || []) {
    if (node?.nodeType !== 'leaf' || !node.leaf?.signaturePublicKey) continue;
    out.add(encode64(node.leaf.signaturePublicKey));
  }
  return out;
}

/// Null accepts. Always allowed: another device of someone already in the group, an external commit (needs GroupInfo sealed to the joiner's recovery key), a member removing their own leaves.
export function judgeCommit(policy, tree, {
  senderLeafIndex, proposals, joinerKey = null, joiner = null, revoked = null,
}) {
  if (policy === undefined) return 'this group’s membership policy does not parse';
  const committer = senderLeafIndex === undefined ? null : leafIdentity(tree, senderLeafIndex)?.userId || null;
  // A revoked device may not commit, join, or be added back.
  const isRevoked = (userId, key) => Boolean(revoked && userId && key && revoked(userId, encode64(key)));
  if (committer && isRevoked(committer, leafSignatureKey(tree, senderLeafIndex))) {
    return `a device ${committer} revoked may not change this group`;
  }
  if (senderLeafIndex === undefined && isRevoked(joiner, joinerKey)) {
    return `a device ${joiner} revoked may not join this group`;
  }
  const present = usersInTree(tree);
  for (const { proposal, senderLeafIndex: proposedBy } of proposals || []) {
    switch (proposal?.proposalType) {
      case 'add': {
        const leaf = proposal.add?.keyPackage?.leafNode;
        const who = identityOf(leaf?.credential)?.userId;
        if (!who) return 'an add that names nobody';
        if (isRevoked(who, leaf?.signaturePublicKey)) {
          return `a device ${who} revoked may not be added to this group`;
        }
        if (present.has(who) || !policy) break;
        if (!policyAllows(policy, 'add', committer)) {
          return `${committer || 'somebody outside the group'} may not add people to this group`;
        }
        break;
      }
      case 'remove': {
        const removed = proposal.remove?.removed;
        const who = leafIdentity(tree, removed)?.userId || null;
        // An external commit may remove only its own earlier leaf (`resync`); else a GroupInfo holder could remove others.
        if (senderLeafIndex === undefined) {
          if (joinerKey && sameBytes(leafSignatureKey(tree, removed), joinerKey)) break;
          return 'a join from outside the group may only replace its own leaf';
        }
        // A Remove proposed by the removed person is them leaving.
        const proposer = proposedBy === undefined ? null : leafIdentity(tree, proposedBy)?.userId || null;
        if (!policy || (who && (who === committer || who === proposer))) break;
        if (!policyAllows(policy, 'remove', committer)) {
          return `${committer || 'somebody outside the group'} may not remove people from this group`;
        }
        break;
      }
      case 'group_context_extensions': {
        const next = policyIn(proposal.groupContextExtensions?.extensions);
        if (next === undefined) return 'a membership policy that does not parse';
        if (!policy) {
          // No policy means every member holds every right; the first adopter must name itself creator.
          if (next && next.creator !== committer) {
            return 'a membership policy must name the member adopting it as creator';
          }
          break;
        }
        if (!next) return 'a group’s membership policy cannot be taken away';
        if (next.creator !== policy.creator) return 'the creator of a group cannot be changed';
        if (samePolicy(next, policy)) break;
        if (!policyAllows(policy, 'policy', committer)) {
          return `${committer || 'somebody outside the group'} may not change this group’s policy`;
        }
        break;
      }
      default:
        break;
    }
  }
  return null;
}
