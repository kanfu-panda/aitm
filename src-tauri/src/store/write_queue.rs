//! 按提交顺序在后台线程执行的写库队列。
//!
//! rusqlite 是同步 API。在 tokio worker 上直接写库，磁盘慢时会占住 worker、拖慢
//! 其它异步任务（见本模块上层 `store/mod.rs` 的约定）。而 AI 流式事件的回调
//! （`EventSink`）是同步函数，没法 `.await` 一个 `spawn_blocking`；各自丢
//! `spawn_blocking` 又会打乱消息落盘顺序（assistant 文本 → tool_call → 文本）。
//!
//! 所以用一条专用线程串行执行：`submit` 立即返回，任务按提交顺序执行。
//! 队列被丢弃后，线程把已提交的任务执行完再退出。

use std::sync::mpsc;

type Job = Box<dyn FnOnce() + Send + 'static>;

/// 单线程、按序执行的后台写入队列。
pub struct WriteQueue {
    tx: mpsc::Sender<Job>,
}

impl WriteQueue {
    /// 新建队列并启动工作线程。`label` 只用于线程名与日志。
    pub fn new(label: &str) -> Self {
        let (tx, rx) = mpsc::channel::<Job>();
        let name = format!("aitm-write-{label}");
        let spawned = std::thread::Builder::new().name(name).spawn(move || {
            // 发送端全部丢弃后 recv 返回 Err，线程在执行完剩余任务后退出
            while let Ok(job) = rx.recv() {
                // 单个任务 panic 不能让后续写入全部丢失
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).is_err() {
                    tracing::warn!("后台写库任务 panic，已跳过");
                }
            }
        });
        if let Err(e) = spawned {
            tracing::error!("启动后台写库线程失败：{e}");
        }
        Self { tx }
    }

    /// 提交一个任务，立即返回。工作线程已不在时丢弃任务并记日志。
    pub fn submit<F: FnOnce() + Send + 'static>(&self, job: F) {
        if self.tx.send(Box::new(job)).is_err() {
            tracing::warn!("后台写库线程不可用，任务被丢弃");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    #[test]
    fn 应该_按提交顺序执行() {
        let q = WriteQueue::new("测试");
        let log = Arc::new(Mutex::new(Vec::new()));
        for i in 0..50 {
            let log = log.clone();
            q.submit(move || log.lock().unwrap().push(i));
        }
        let (tx, rx) = mpsc::channel();
        q.submit(move || tx.send(()).unwrap());
        rx.recv_timeout(Duration::from_secs(5)).unwrap();

        assert_eq!(*log.lock().unwrap(), (0..50).collect::<Vec<_>>());
    }

    #[test]
    fn 应该_不在调用方线程执行_提交立即返回() {
        let q = WriteQueue::new("测试");
        let caller = std::thread::current().id();
        let (tx, rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        // 第一个任务卡住：若 submit 是同步执行的，这里会死等
        q.submit(move || {
            release_rx.recv().unwrap();
        });
        q.submit(move || tx.send(std::thread::current().id()).unwrap());
        release_tx.send(()).unwrap();

        let worker = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_ne!(worker, caller);
    }

    #[test]
    fn 应该_在队列被丢弃后_仍执行完已提交的任务() {
        let (tx, rx) = mpsc::channel();
        {
            let q = WriteQueue::new("测试");
            q.submit(move || tx.send(42).unwrap());
        }
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), 42);
    }

    #[test]
    fn 应该_当某个任务_panic_时_后续任务照常执行() {
        let q = WriteQueue::new("测试");
        q.submit(|| panic!("模拟写库出错"));
        let (tx, rx) = mpsc::channel();
        q.submit(move || tx.send(1).unwrap());
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), 1);
    }
}
