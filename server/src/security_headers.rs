use axum::extract::Request;
use axum::http::{header, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;

const CONTENT_SECURITY_POLICY: &str =
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

pub async fn layer(req: Request, next: Next) -> Response {
    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();

    headers.insert(
        header::HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        header::HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    if !headers.contains_key(header::CONTENT_SECURITY_POLICY) {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CONTENT_SECURITY_POLICY),
        );
    }

    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    #[tokio::test]
    async fn a_handler_policy_is_kept_and_a_missing_one_is_filled() {
        let app = Router::new()
            .route("/plain", get(|| async { Response::new(Body::empty()) }))
            .route(
                "/sandboxed",
                get(|| async {
                    let mut resp = Response::new(Body::empty());
                    resp.headers_mut().insert(
                        header::CONTENT_SECURITY_POLICY,
                        HeaderValue::from_static("default-src 'none'; sandbox"),
                    );
                    resp
                }),
            )
            .layer(axum::middleware::from_fn(layer));
        for (path, expected) in [("/plain", CONTENT_SECURITY_POLICY), ("/sandboxed", "default-src 'none'; sandbox")] {
            let req = Request::builder().uri(path).body(Body::empty()).unwrap();
            let resp = app.clone().oneshot(req).await.unwrap();
            assert_eq!(resp.headers()[header::CONTENT_SECURITY_POLICY], expected, "{path}");
        }
    }
}
