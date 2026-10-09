//! 履歴。タイル差分だけを持ち、MB 上限で古いものから捨てる。
//!
//! 1 項目は「触ったタイルの、もう片方の状態」。Undo は現在と入れ替えるだけなので、
//! タイル 1 枚につきコピーは 1 つで済む。

use std::collections::VecDeque;

use crate::cel::Snapshot;
use crate::document::LayerId;

pub struct Entry {
    pub label: String,
    pub layer: LayerId,
    /// 入れ替え用の状態(undo 側では「変更前」、redo 側では「変更後」)
    pub tiles: Snapshot,
}

impl Entry {
    pub fn bytes(&self) -> usize {
        self.tiles
            .iter()
            .map(|(_, t)| t.as_ref().map_or(0, |t| t.bytes()) + 16)
            .sum()
    }
}

pub struct History {
    undo: VecDeque<Entry>,
    redo: Vec<Entry>,
    bytes: usize,
    limit: usize,
}

impl History {
    pub fn new(limit_bytes: usize) -> Self {
        Self {
            undo: VecDeque::new(),
            redo: Vec::new(),
            bytes: 0,
            limit: limit_bytes,
        }
    }

    pub fn limit_bytes(&self) -> usize {
        self.limit
    }
    pub fn set_limit_bytes(&mut self, limit: usize) {
        self.limit = limit;
        self.evict();
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn undo_len(&self) -> usize {
        self.undo.len()
    }
    pub fn redo_len(&self) -> usize {
        self.redo.len()
    }
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// 新しい操作。redo は捨てる。空の差分は積まない。
    pub fn push(&mut self, entry: Entry) {
        if entry.tiles.is_empty() {
            return;
        }
        for e in self.redo.drain(..) {
            self.bytes -= e.bytes();
        }
        self.bytes += entry.bytes();
        self.undo.push_back(entry);
        self.evict();
    }

    pub fn pop_undo(&mut self) -> Option<Entry> {
        let e = self.undo.pop_back()?;
        self.bytes -= e.bytes();
        Some(e)
    }
    pub fn push_redo(&mut self, entry: Entry) {
        self.bytes += entry.bytes();
        self.redo.push(entry);
    }
    pub fn pop_redo(&mut self) -> Option<Entry> {
        let e = self.redo.pop()?;
        self.bytes -= e.bytes();
        Some(e)
    }
    pub fn push_undo_back(&mut self, entry: Entry) {
        self.bytes += entry.bytes();
        self.undo.push_back(entry);
        self.evict();
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.bytes = 0;
    }

    /// 上限を超えたら古い undo から捨てる。直近 1 件は必ず残す。
    fn evict(&mut self) {
        while self.bytes > self.limit && self.undo.len() > 1 {
            if let Some(e) = self.undo.pop_front() {
                self.bytes -= e.bytes();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tile::{PixelFormat, Tile, TileKey};

    fn entry(n: usize) -> Entry {
        Entry {
            label: "s".into(),
            layer: 1,
            tiles: (0..n)
                .map(|i| (TileKey::new(i as i32, 0), Some(Tile::empty(PixelFormat::A8))))
                .collect(),
        }
    }

    #[test]
    fn evicts_oldest_but_keeps_latest() {
        let tile = PixelFormat::A8.tile_bytes() + 16;
        let mut h = History::new(tile * 3);
        h.push(entry(1));
        h.push(entry(1));
        h.push(entry(1));
        assert_eq!(h.undo_len(), 3);
        h.push(entry(2));
        assert_eq!(h.undo_len(), 2, "古いものが落ちる");
        h.push(entry(10));
        assert_eq!(h.undo_len(), 1, "上限を超えても直近 1 件は残す");
        assert!(h.bytes() > h.limit_bytes());
    }

    #[test]
    fn push_clears_redo_and_empty_is_ignored() {
        let mut h = History::new(1 << 20);
        h.push(entry(1));
        let e = h.pop_undo().unwrap();
        h.push_redo(e);
        assert!(h.can_redo());
        h.push(entry(0));
        assert!(h.can_redo(), "空の差分では redo が消えない");
        h.push(entry(1));
        assert!(!h.can_redo());
        assert_eq!(h.bytes(), entry(1).bytes());
    }
}
