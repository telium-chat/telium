use crate::error::{ApiError, ApiResult};
use crate::util::split_user_id;

const MAX_GROUP_MEMBERS: usize = 50;
const MAX_FRAME_BYTES: usize = 256 * 1024;

pub(crate) fn home_of(user_id: &str) -> ApiResult<String> {
    split_user_id(user_id)
        .map(|(_, domain)| domain.to_string())
        .ok_or_else(|| ApiError::BadRequest(format!("{user_id} is not a user id")))
}

mod keypackages;
mod verification;
mod vault;
mod backup;
mod conversations;
mod typing;
mod notifications;
mod history;
mod send;
mod sequencing;
mod outbox;
mod inbound;
mod members;
mod handoff;
mod promote;
mod policy;

pub use keypackages::*;
pub use verification::*;
pub use vault::*;
pub use backup::*;
pub use conversations::*;
pub use typing::*;
pub use notifications::*;
pub use history::*;
pub use send::*;
use sequencing::*;
pub use outbox::*;
pub use inbound::*;
pub use members::*;
pub use handoff::*;
pub use promote::*;
pub use policy::*;
