//! SSE 解析辅助。
//!
//! 把 reqwest 流式 response 转成 eventsource-stream 的 Event 流，
//! 各 provider 基于这个再做自家协议→ChatChunk 翻译。

use eventsource_stream::Eventsource;
use futures::stream::{Stream, TryStreamExt};
use reqwest::Response;

use super::ProviderError;

/// 把 HTTP response 的 body 转成 SSE Event 流。
pub fn sse_from_response(
    resp: Response,
) -> impl Stream<Item = Result<eventsource_stream::Event, ProviderError>> {
    let bytes_stream = resp
        .bytes_stream()
        .map_err(ProviderError::Http);
    bytes_stream
        .eventsource()
        .map_err(|e| ProviderError::Protocol(format!("SSE 解析: {e}")))
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use eventsource_stream::Eventsource;
    use futures::StreamExt;

    /// 模拟一个 SSE 字节流（不走真 HTTP），验证 eventsource-stream 解析正常。
    #[tokio::test]
    async fn 多条_sse_事件能被解析() {
        let raw = "event: foo\ndata: hello\n\nevent: bar\ndata: world\n\n";
        let chunks: Vec<Result<Bytes, std::io::Error>> = vec![Ok(Bytes::from(raw))];
        let stream = futures::stream::iter(chunks);
        let mut events = stream.eventsource();

        let first = events.next().await.unwrap().unwrap();
        assert_eq!(first.event, "foo");
        assert_eq!(first.data, "hello");

        let second = events.next().await.unwrap().unwrap();
        assert_eq!(second.event, "bar");
        assert_eq!(second.data, "world");

        assert!(events.next().await.is_none());
    }
}
