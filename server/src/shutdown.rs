
use std::future::{Future, IntoFuture};
use std::time::Duration;

use tokio::sync::oneshot;

pub async fn bounded<S>(
    served: S,
    begun: oneshot::Receiver<()>,
    grace: Duration,
) -> Option<<S::IntoFuture as Future>::Output>
where
    S: IntoFuture,
{
    let deadline = async move {
        match begun.await {
            Ok(()) => tokio::time::sleep(grace).await,
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        out = served.into_future() => Some(out),
        () = deadline => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRACE: Duration = Duration::from_secs(15);

    #[tokio::test(start_paused = true)]
    async fn the_grace_period_starts_at_shutdown_not_at_boot() {
        let (_tx, rx) = oneshot::channel::<()>();
        let run = bounded(std::future::pending::<()>(), rx, GRACE);
        assert!(tokio::time::timeout(Duration::from_secs(3600), run).await.is_err());

        let (tx, rx) = oneshot::channel::<()>();
        let start = tokio::time::Instant::now();
        let run = tokio::spawn(bounded(std::future::pending::<()>(), rx, GRACE));
        tokio::time::sleep(Duration::from_secs(100)).await;
        tx.send(()).unwrap();
        assert_eq!(run.await.unwrap(), None);
        assert_eq!(start.elapsed(), Duration::from_secs(100) + GRACE);

        let (tx, rx) = oneshot::channel::<()>();
        tx.send(()).unwrap();
        assert_eq!(bounded(async { 7 }, rx, GRACE).await, Some(7));
    }
}
