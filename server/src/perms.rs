
use serde::{Deserialize, Serialize};

pub const VIEW_CHANNEL: u64 = 1 << 0;
pub const SEND_MESSAGES: u64 = 1 << 1;
pub const MANAGE_MESSAGES: u64 = 1 << 2;
pub const MANAGE_CHANNELS: u64 = 1 << 3;
pub const MANAGE_ROLES: u64 = 1 << 4;
pub const KICK_MEMBERS: u64 = 1 << 5;
pub const BAN_MEMBERS: u64 = 1 << 6;
pub const MANAGE_GUILD: u64 = 1 << 7;
pub const MANAGE_EXPRESSIONS: u64 = 1 << 8;
pub const CREATE_INVITE: u64 = 1 << 9;
pub const ATTACH_FILES: u64 = 1 << 10;
pub const EMBED_LINKS: u64 = 1 << 11;
pub const MENTION_EVERYONE: u64 = 1 << 12;
pub const MODERATE_MEMBERS: u64 = 1 << 13;
pub const USE_EXTERNAL_EMOJI: u64 = 1 << 14;
pub const CONNECT: u64 = 1 << 15;
pub const SPEAK: u64 = 1 << 16;
pub const VIDEO: u64 = 1 << 17;
pub const STREAM: u64 = 1 << 18;
pub const VIEW_AUDIT_LOG: u64 = 1 << 19;
pub const ADD_REACTIONS: u64 = 1 << 20;
pub const READ_MESSAGE_HISTORY: u64 = 1 << 21;
pub const PRIORITY_SPEAKER: u64 = 1 << 22;
pub const MUTE_MEMBERS: u64 = 1 << 23;
pub const DEAFEN_MEMBERS: u64 = 1 << 24;
pub const MOVE_MEMBERS: u64 = 1 << 25;
pub const ADMINISTRATOR: u64 = 1 << 40;

pub const DEFAULT_EVERYONE: u64 = VIEW_CHANNEL
    | SEND_MESSAGES
    | CREATE_INVITE
    | ATTACH_FILES
    | EMBED_LINKS
    | ADD_REACTIONS
    | READ_MESSAGE_HISTORY
    | USE_EXTERNAL_EMOJI
    | CONNECT
    | SPEAK
    | VIDEO
    | STREAM;

pub const TIMEOUT_ALLOWED: u64 = VIEW_CHANNEL | READ_MESSAGE_HISTORY;

pub fn name_to_bit(name: &str) -> Option<u64> {
    Some(match name {
        "VIEW_CHANNEL" => VIEW_CHANNEL,
        "SEND_MESSAGES" => SEND_MESSAGES,
        "MANAGE_MESSAGES" => MANAGE_MESSAGES,
        "MANAGE_CHANNELS" => MANAGE_CHANNELS,
        "MANAGE_ROLES" => MANAGE_ROLES,
        "KICK_MEMBERS" => KICK_MEMBERS,
        "BAN_MEMBERS" => BAN_MEMBERS,
        "MANAGE_GUILD" => MANAGE_GUILD,
        "MANAGE_EXPRESSIONS" => MANAGE_EXPRESSIONS,
        "CREATE_INVITE" => CREATE_INVITE,
        "ATTACH_FILES" => ATTACH_FILES,
        "EMBED_LINKS" => EMBED_LINKS,
        "MENTION_EVERYONE" => MENTION_EVERYONE,
        "MODERATE_MEMBERS" => MODERATE_MEMBERS,
        "USE_EXTERNAL_EMOJI" => USE_EXTERNAL_EMOJI,
        "CONNECT" => CONNECT,
        "SPEAK" => SPEAK,
        "VIDEO" => VIDEO,
        "STREAM" => STREAM,
        "VIEW_AUDIT_LOG" => VIEW_AUDIT_LOG,
        "ADD_REACTIONS" => ADD_REACTIONS,
        "READ_MESSAGE_HISTORY" => READ_MESSAGE_HISTORY,
        "PRIORITY_SPEAKER" => PRIORITY_SPEAKER,
        "MUTE_MEMBERS" => MUTE_MEMBERS,
        "DEAFEN_MEMBERS" => DEAFEN_MEMBERS,
        "MOVE_MEMBERS" => MOVE_MEMBERS,
        "ADMINISTRATOR" => ADMINISTRATOR,
        _ => return None,
    })
}

pub fn bits_to_names(bits: u64) -> Vec<&'static str> {
    const ALL: &[(&str, u64)] = &[
        ("VIEW_CHANNEL", VIEW_CHANNEL),
        ("SEND_MESSAGES", SEND_MESSAGES),
        ("MANAGE_MESSAGES", MANAGE_MESSAGES),
        ("MANAGE_CHANNELS", MANAGE_CHANNELS),
        ("MANAGE_ROLES", MANAGE_ROLES),
        ("KICK_MEMBERS", KICK_MEMBERS),
        ("BAN_MEMBERS", BAN_MEMBERS),
        ("MANAGE_GUILD", MANAGE_GUILD),
        ("MANAGE_EXPRESSIONS", MANAGE_EXPRESSIONS),
        ("CREATE_INVITE", CREATE_INVITE),
        ("ATTACH_FILES", ATTACH_FILES),
        ("EMBED_LINKS", EMBED_LINKS),
        ("MENTION_EVERYONE", MENTION_EVERYONE),
        ("MODERATE_MEMBERS", MODERATE_MEMBERS),
        ("USE_EXTERNAL_EMOJI", USE_EXTERNAL_EMOJI),
        ("CONNECT", CONNECT),
        ("SPEAK", SPEAK),
        ("VIDEO", VIDEO),
        ("STREAM", STREAM),
        ("VIEW_AUDIT_LOG", VIEW_AUDIT_LOG),
        ("ADD_REACTIONS", ADD_REACTIONS),
        ("READ_MESSAGE_HISTORY", READ_MESSAGE_HISTORY),
        ("PRIORITY_SPEAKER", PRIORITY_SPEAKER),
        ("MUTE_MEMBERS", MUTE_MEMBERS),
        ("DEAFEN_MEMBERS", DEAFEN_MEMBERS),
        ("MOVE_MEMBERS", MOVE_MEMBERS),
        ("ADMINISTRATOR", ADMINISTRATOR),
    ];
    ALL.iter().filter(|(_, b)| bits & b != 0).map(|(n, _)| *n).collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Overwrite {
    pub target_type: String, // "role" | "member"
    pub target_id: String,
    pub allow: u64,
    pub deny: u64,
}

pub struct MemberContext<'a> {
    pub user_id: &'a str,
    pub guild_id: &'a str,
    pub guild_owner: &'a str,
    pub roles: &'a [(String, u64)],
    pub permission_ceiling: Option<u64>,
    pub timed_out: bool,
}

fn apply_ceiling(ctx: &MemberContext, permissions: u64) -> u64 {
    let Some(ceiling) = ctx.permission_ceiling else {
        return permissions;
    };
    if ceiling & ADMINISTRATOR != 0 {
        permissions
    } else {
        permissions & ceiling
    }
}

pub fn base_permissions(ctx: &MemberContext) -> u64 {
    let permissions = if ctx.user_id == ctx.guild_owner {
        u64::MAX
    } else {
        let bits = ctx.roles.iter().fold(0u64, |acc, (_, p)| acc | p);
        if bits & ADMINISTRATOR != 0 { u64::MAX } else { bits }
    };
    apply_ceiling(ctx, permissions)
}

pub fn guild_permissions(ctx: &MemberContext) -> u64 {
    apply_timeout(ctx, base_permissions(ctx))
}

pub fn channel_permissions(ctx: &MemberContext, overwrites: &[Overwrite]) -> u64 {
    let mut perms = base_permissions(ctx);
    if perms == u64::MAX {
        return apply_timeout(ctx, perms);
    }

    if let Some(everyone) = overwrites
        .iter()
        .find(|o| o.target_type == "role" && o.target_id == ctx.guild_id)
    {
        perms &= !everyone.deny;
        perms |= everyone.allow;
    }

    let (mut allow, mut deny) = (0u64, 0u64);
    for o in overwrites.iter().filter(|o| o.target_type == "role" && o.target_id != ctx.guild_id) {
        if ctx.roles.iter().any(|(id, _)| *id == o.target_id) {
            allow |= o.allow;
            deny |= o.deny;
        }
    }
    perms &= !deny;
    perms |= allow;

    if let Some(member) = overwrites
        .iter()
        .find(|o| o.target_type == "member" && o.target_id == ctx.user_id)
    {
        perms &= !member.deny;
        perms |= member.allow;
    }

    apply_timeout(ctx, apply_ceiling(ctx, perms))
}

fn apply_timeout(ctx: &MemberContext, perms: u64) -> u64 {
    if ctx.timed_out {
        perms & TIMEOUT_ALLOWED
    } else {
        perms
    }
}

pub fn has(perms: u64, bit: u64) -> bool {
    perms & bit != 0
}

pub fn outranks(actor_top: i64, actor_is_owner: bool, target_top: i64, target_is_owner: bool) -> bool {
    if target_is_owner {
        return false;
    }
    actor_is_owner || actor_top > target_top
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(roles: &'a [(String, u64)], timed_out: bool) -> MemberContext<'a> {
        MemberContext {
            user_id: "@alice:home.example",
            guild_id: "G",
            guild_owner: "@owner:home.example",
            roles,
            permission_ceiling: None,
            timed_out,
        }
    }

    #[test]
    fn owner_has_everything() {
        let roles = vec![("G".to_string(), 0u64)];
        let mut c = ctx(&roles, false);
        c.user_id = "@owner:home.example";
        assert_eq!(base_permissions(&c), u64::MAX);
    }

    #[test]
    fn administrator_implies_all() {
        let roles = vec![("G".to_string(), ADMINISTRATOR)];
        assert_eq!(base_permissions(&ctx(&roles, false)), u64::MAX);
    }

    #[test]
    fn roles_union() {
        let roles = vec![("G".into(), VIEW_CHANNEL), ("r2".into(), SEND_MESSAGES)];
        let p = base_permissions(&ctx(&roles, false));
        assert!(has(p, VIEW_CHANNEL) && has(p, SEND_MESSAGES));
    }

    #[test]
    fn bot_permission_ceiling_beats_everyone_and_channel_allows() {
        let roles = vec![
            ("G".into(), DEFAULT_EVERYONE),
            ("bot".into(), VIEW_CHANNEL | READ_MESSAGE_HISTORY),
        ];
        let mut c = ctx(&roles, false);
        c.permission_ceiling = Some(VIEW_CHANNEL | READ_MESSAGE_HISTORY);
        assert!(!has(base_permissions(&c), SEND_MESSAGES));

        let ow = vec![Overwrite {
            target_type: "member".into(),
            target_id: "@alice:home.example".into(),
            allow: SEND_MESSAGES,
            deny: 0,
        }];
        assert!(!has(channel_permissions(&c, &ow), SEND_MESSAGES));
        assert!(has(channel_permissions(&c, &ow), VIEW_CHANNEL));
    }

    #[test]
    fn member_overwrite_beats_role_deny() {
        let roles = vec![("G".into(), DEFAULT_EVERYONE), ("r2".into(), 0)];
        let ow = vec![
            Overwrite { target_type: "role".into(), target_id: "r2".into(), allow: 0, deny: SEND_MESSAGES },
            Overwrite {
                target_type: "member".into(),
                target_id: "@alice:home.example".into(),
                allow: SEND_MESSAGES,
                deny: 0,
            },
        ];
        assert!(has(channel_permissions(&ctx(&roles, false), &ow), SEND_MESSAGES));
    }

    #[test]
    fn everyone_deny_applies_before_role_allow() {
        let roles = vec![("G".into(), DEFAULT_EVERYONE), ("r2".into(), 0)];
        let ow = vec![
            Overwrite { target_type: "role".into(), target_id: "G".into(), allow: 0, deny: VIEW_CHANNEL },
            Overwrite { target_type: "role".into(), target_id: "r2".into(), allow: VIEW_CHANNEL, deny: 0 },
        ];
        assert!(has(channel_permissions(&ctx(&roles, false), &ow), VIEW_CHANNEL));
    }

    #[test]
    fn private_channel_hides_from_everyone() {
        let roles = vec![("G".into(), DEFAULT_EVERYONE)];
        let ow = vec![Overwrite {
            target_type: "role".into(),
            target_id: "G".into(),
            allow: 0,
            deny: VIEW_CHANNEL,
        }];
        assert!(!has(channel_permissions(&ctx(&roles, false), &ow), VIEW_CHANNEL));
    }

    #[test]
    fn timeout_leaves_only_read_access() {
        let roles = vec![("G".into(), DEFAULT_EVERYONE | ADMINISTRATOR)];
        let p = channel_permissions(&ctx(&roles, true), &[]);
        assert!(has(p, VIEW_CHANNEL));
        assert!(!has(p, SEND_MESSAGES));
    }

    #[test]
    fn timeout_reaches_guild_level_permissions_too() {
        let roles = vec![("G".into(), DEFAULT_EVERYONE | KICK_MEMBERS | BAN_MEMBERS)];
        let c = ctx(&roles, true);
        assert!(has(base_permissions(&c), BAN_MEMBERS), "base_permissions is the pre-timeout view");
        assert_eq!(guild_permissions(&c), TIMEOUT_ALLOWED);
        assert!(!has(guild_permissions(&c), KICK_MEMBERS));

        let roles = vec![("G".into(), ADMINISTRATOR)];
        assert_eq!(guild_permissions(&ctx(&roles, true)), TIMEOUT_ALLOWED);

        let roles = vec![("G".into(), DEFAULT_EVERYONE | BAN_MEMBERS)];
        let c = ctx(&roles, false);
        assert_eq!(guild_permissions(&c), base_permissions(&c));
    }

    #[test]
    fn hierarchy_protects_the_owner() {
        assert!(!outranks(i64::MAX, false, 0, true));
        assert!(outranks(5, false, 3, false));
        assert!(!outranks(3, false, 3, false));
        assert!(outranks(0, true, 9, false));
    }
}
