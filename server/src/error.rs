use std::borrow::Cow;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    /// Step-up reauth needed: rendered `403` with its own code (`forbidden` hides the control, this prompts for a password).
    #[error("{0}")]
    StepUpRequired(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    /// Conflict worth retrying; its own code lets unattended callers wait rather than choose another.
    #[error("{0}")]
    TryAgain(String),
    /// Well-formed JSON the route can't act on; distinct from `BadRequest` (client bug vs version skew).
    #[error("{0}")]
    Unprocessable(String),
    /// No common protocol version: never retried; `400` because only an upgrade changes it.
    #[error("{0}")]
    Incompatible(String),
    #[error("{0}")]
    TooLarge(String),
    #[error("{0}")]
    RateLimited(String),
    /// Upstream failures stay `5xx`: a `400` would be read as a device-continuity refusal.
    #[error("{0}")]
    BadGateway(String),
    #[error("{0}")]
    UpstreamUnavailable(String),
    #[error("{0}")]
    GatewayTimeout(String),
    #[error("internal error")]
    Internal(#[from] anyhow::Error),
    #[error("internal error")]
    Db(#[from] sqlx::Error),
    #[error("{}", .0.message)]
    Tagged(Box<Tagged>),
}

/// A refusal plus a code and detail fields; status and class are copied so a code can't reclassify.
#[derive(Debug)]
pub struct Tagged {
    status: StatusCode,
    class: &'static str,
    /// `Cow` so a remote server's code can be carried (`with_remote_code`).
    code: Cow<'static, str>,
    message: String,
    detail: serde_json::Map<String, serde_json::Value>,
}

impl Tagged {
    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn detail(&self) -> &serde_json::Map<String, serde_json::Value> {
        &self.detail
    }
}

impl ApiError {
    fn parts(&self) -> (StatusCode, &'static str) {
        match self {
            ApiError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            ApiError::Unauthorized(_) => (StatusCode::UNAUTHORIZED, "unauthorized"),
            ApiError::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden"),
            ApiError::StepUpRequired(_) => (StatusCode::FORBIDDEN, "step_up_required"),
            ApiError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            ApiError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            ApiError::TryAgain(_) => (StatusCode::CONFLICT, "try_again"),
            ApiError::Unprocessable(_) => {
                (StatusCode::UNPROCESSABLE_ENTITY, "unprocessable_entity")
            }
            ApiError::Incompatible(_) => (StatusCode::BAD_REQUEST, "incompatible_protocol"),
            ApiError::TooLarge(_) => (StatusCode::PAYLOAD_TOO_LARGE, "too_large"),
            ApiError::RateLimited(_) => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            ApiError::BadGateway(_) => (StatusCode::BAD_GATEWAY, "bad_gateway"),
            ApiError::UpstreamUnavailable(_) => {
                (StatusCode::SERVICE_UNAVAILABLE, "upstream_unavailable")
            }
            ApiError::GatewayTimeout(_) => (StatusCode::GATEWAY_TIMEOUT, "gateway_timeout"),
            ApiError::Internal(_) | ApiError::Db(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal")
            }
            ApiError::Tagged(tagged) => (tagged.status, tagged.class),
        }
    }

    /// Attach a machine-readable code to this refusal.
    ///
    /// ```ignore
    /// return Err(ApiError::Forbidden(format!("missing permission {name}"))
    ///     .with_code(errcodes::MISSING_PERMISSION)
    ///     .with_detail("permission", name));
    /// ```
    /// A `500` refuses the code and returns unchanged.
    pub fn with_code(self, code: impl Into<Cow<'static, str>>) -> Self {
        let (status, class) = self.parts();
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            return self;
        }
        let code = code.into();
        match self {
            ApiError::Tagged(mut tagged) => {
                tagged.code = code;
                ApiError::Tagged(tagged)
            }
            other => {
                let message = other.to_string();
                ApiError::Tagged(Box::new(Tagged {
                    status,
                    class,
                    code,
                    message,
                    detail: serde_json::Map::new(),
                }))
            }
        }
    }

    /// Attach one structured field (rule 4 of `crate::errcodes`); dropped silently on an uncoded refusal.
    pub fn with_detail(self, key: impl Into<String>, value: impl Into<serde_json::Value>) -> Self {
        match self {
            ApiError::Tagged(mut tagged) => {
                tagged.detail.insert(key.into(), value.into());
                ApiError::Tagged(tagged)
            }
            other => other,
        }
    }

    /// HTTP status. Match on this, never the variant: `with_code` preserves status but not the variant.
    pub fn status(&self) -> StatusCode {
        self.parts().0
    }

    /// Carry a code and its values across a federation hop; the code must have the `errcodes` shape and only scalar details are copied.
    pub fn with_remote_code(self, body: &serde_json::Value) -> Self {
        let Some(code) = body.get("code").and_then(serde_json::Value::as_str) else {
            return self;
        };
        let well_formed = !code.is_empty()
            && code.len() <= 48
            && code
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        if !well_formed {
            return self;
        }
        let mut out = self.with_code(Cow::Owned(code.to_string()));
        if let Some(fields) = body.as_object() {
            for (key, value) in fields {
                if key == "error" || key == "code" || key == "message" {
                    continue;
                }
                if value.is_object() || value.is_array() {
                    continue;
                }
                out = out.with_detail(key.clone(), value.clone());
            }
        }
        out
    }

    pub fn code(&self) -> &str {
        match self {
            ApiError::Tagged(tagged) => &tagged.code,
            _ => "",
        }
    }

    pub fn body(&self) -> serde_json::Value {
        let (_, class) = self.parts();
        let mut body = serde_json::Map::new();
        body.insert("error".into(), serde_json::Value::String(class.into()));
        if let ApiError::Tagged(tagged) = self {
            if !tagged.code.is_empty() {
                body.insert(
                    "code".into(),
                    serde_json::Value::String(tagged.code.to_string()),
                );
            }
            for (key, value) in &tagged.detail {
                // Detail must not shadow the protocol field names.
                if key != "error" && key != "code" && key != "message" {
                    body.insert(key.clone(), value.clone());
                }
            }
        }
        body.insert("message".into(), serde_json::Value::String(self.to_string()));
        serde_json::Value::Object(body)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, _class) = self.parts();
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            // Display says nothing; the log gets the real cause, which must never interpolate secrets (`tests/telemetry_leaks.rs` scans for it).
            tracing::error!(target: crate::logcat::REQUEST, error = ?self, "request failed");
        }
        (status, Json(self.body())).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

/// A refusal with a stable `code`, so clients needn't match prose; renders the same body plus one field.
/// ```text
/// {"error":"forbidden","code":"bot_not_installed","message":"bot is not installed on this guild server"}
/// ```
#[derive(Debug)]
pub struct Coded(ApiError, &'static str);

impl Coded {
    pub fn new(error: ApiError, code: &'static str) -> Self {
        Self(error, code)
    }

    pub fn error(&self) -> &ApiError {
        &self.0
    }

    pub fn code(&self) -> &'static str {
        self.1
    }
}

impl<E: Into<ApiError>> From<E> for Coded {
    fn from(error: E) -> Self {
        Self(error.into(), "")
    }
}

impl IntoResponse for Coded {
    fn into_response(self) -> Response {
        if self.1.is_empty() {
            return self.0.into_response();
        }
        // Delegated: `with_code` holds the no-code-on-a-500 rule and the body shape.
        self.0.with_code(self.1).into_response()
    }
}
