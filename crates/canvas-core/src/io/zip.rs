//! 最小の zip。store と deflate だけ。暗号化、zip64、分割は扱わない。
//! 外の道具(エクスプローラー、unzip)で開けることが目的。

use std::collections::HashMap;

fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    for (i, slot) in t.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    t
}

pub fn crc32(data: &[u8]) -> u32 {
    let t = crc_table();
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = t[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

fn u16le(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn u32le(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn rd16(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(o)?, *b.get(o + 1)?]))
}
fn rd32(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(o)?,
        *b.get(o + 1)?,
        *b.get(o + 2)?,
        *b.get(o + 3)?,
    ]))
}

struct Entry {
    name: String,
    method: u16,
    crc: u32,
    csize: u32,
    usize_: u32,
    offset: u32,
}

pub struct ZipWriter {
    buf: Vec<u8>,
    entries: Vec<Entry>,
}

impl Default for ZipWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl ZipWriter {
    pub fn new() -> Self {
        Self {
            buf: Vec::new(),
            entries: Vec::new(),
        }
    }

    /// `deflate` が真なら圧縮する(縮まないときは store に落とす)。
    pub fn add(&mut self, name: &str, data: &[u8], deflate: bool) {
        let crc = crc32(data);
        let mut method = 0u16;
        let mut body: std::borrow::Cow<[u8]> = std::borrow::Cow::Borrowed(data);
        if deflate && !data.is_empty() {
            let c = miniz_oxide::deflate::compress_to_vec(data, 6);
            if c.len() < data.len() {
                method = 8;
                body = std::borrow::Cow::Owned(c);
            }
        }
        let offset = self.buf.len() as u32;
        let b = &mut self.buf;
        u32le(b, 0x0403_4B50);
        u16le(b, 20);
        u16le(b, 0x0800); // UTF-8 名
        u16le(b, method);
        u16le(b, 0);
        u16le(b, 0x21); // 1980-01-01
        u32le(b, crc);
        u32le(b, body.len() as u32);
        u32le(b, data.len() as u32);
        u16le(b, name.len() as u16);
        u16le(b, 0);
        b.extend_from_slice(name.as_bytes());
        b.extend_from_slice(&body);
        self.entries.push(Entry {
            name: name.to_string(),
            method,
            crc,
            csize: body.len() as u32,
            usize_: data.len() as u32,
            offset,
        });
    }

    pub fn finish(mut self) -> Vec<u8> {
        let cd_start = self.buf.len() as u32;
        for e in &self.entries {
            let b = &mut self.buf;
            u32le(b, 0x0201_4B50);
            u16le(b, 20);
            u16le(b, 20);
            u16le(b, 0x0800);
            u16le(b, e.method);
            u16le(b, 0);
            u16le(b, 0x21);
            u32le(b, e.crc);
            u32le(b, e.csize);
            u32le(b, e.usize_);
            u16le(b, e.name.len() as u16);
            u16le(b, 0);
            u16le(b, 0);
            u16le(b, 0);
            u16le(b, 0);
            u32le(b, 0);
            u32le(b, e.offset);
            b.extend_from_slice(e.name.as_bytes());
        }
        let cd_size = self.buf.len() as u32 - cd_start;
        let n = self.entries.len() as u16;
        let b = &mut self.buf;
        u32le(b, 0x0605_4B50);
        u16le(b, 0);
        u16le(b, 0);
        u16le(b, n);
        u16le(b, n);
        u32le(b, cd_size);
        u32le(b, cd_start);
        u16le(b, 0);
        self.buf
    }
}

pub struct ZipReader<'a> {
    data: &'a [u8],
    entries: HashMap<String, Entry>,
}

impl<'a> ZipReader<'a> {
    pub fn new(data: &'a [u8]) -> Result<Self, String> {
        // EOCD を後ろから探す(コメントは最大 64KB)
        let min = data.len().saturating_sub(65_557 + 22);
        let mut eocd = None;
        let mut i = data.len().checked_sub(22).ok_or("短すぎる")?;
        loop {
            if rd32(data, i) == Some(0x0605_4B50) {
                eocd = Some(i);
                break;
            }
            if i == min {
                break;
            }
            i -= 1;
        }
        let eocd = eocd.ok_or("zip の終端が無い")?;
        let n = rd16(data, eocd + 10).ok_or("EOCD")? as usize;
        let cd_start = rd32(data, eocd + 16).ok_or("EOCD")? as usize;
        let mut entries = HashMap::with_capacity(n);
        let mut p = cd_start;
        for _ in 0..n {
            if rd32(data, p) != Some(0x0201_4B50) {
                return Err("中央ディレクトリが壊れている".into());
            }
            let method = rd16(data, p + 10).ok_or("CD")?;
            let crc = rd32(data, p + 16).ok_or("CD")?;
            let csize = rd32(data, p + 20).ok_or("CD")?;
            let usize_ = rd32(data, p + 24).ok_or("CD")?;
            let nlen = rd16(data, p + 28).ok_or("CD")? as usize;
            let xlen = rd16(data, p + 30).ok_or("CD")? as usize;
            let clen = rd16(data, p + 32).ok_or("CD")? as usize;
            let offset = rd32(data, p + 42).ok_or("CD")?;
            let name = std::str::from_utf8(data.get(p + 46..p + 46 + nlen).ok_or("CD 名")?)
                .map_err(|_| "名前が UTF-8 でない")?
                .to_string();
            entries.insert(
                name.clone(),
                Entry {
                    name,
                    method,
                    crc,
                    csize,
                    usize_,
                    offset,
                },
            );
            p += 46 + nlen + xlen + clen;
        }
        Ok(Self { data, entries })
    }

    pub fn names(&self) -> Vec<&str> {
        let mut v: Vec<&str> = self.entries.keys().map(|s| s.as_str()).collect();
        v.sort_unstable();
        v
    }

    pub fn contains(&self, name: &str) -> bool {
        self.entries.contains_key(name)
    }

    pub fn read(&self, name: &str) -> Result<Vec<u8>, String> {
        let e = self.entries.get(name).ok_or_else(|| format!("{name} が無い"))?;
        let o = e.offset as usize;
        if rd32(self.data, o) != Some(0x0403_4B50) {
            return Err(format!("{name} のローカルヘッダが壊れている"));
        }
        let nlen = rd16(self.data, o + 26).ok_or("LH")? as usize;
        let xlen = rd16(self.data, o + 28).ok_or("LH")? as usize;
        let start = o + 30 + nlen + xlen;
        let body = self
            .data
            .get(start..start + e.csize as usize)
            .ok_or_else(|| format!("{name} の本体が足りない"))?;
        let out = match e.method {
            0 => body.to_vec(),
            8 => miniz_oxide::inflate::decompress_to_vec(body)
                .map_err(|_| format!("{name} の展開に失敗"))?,
            m => return Err(format!("{name}: 未対応の圧縮 {m}")),
        };
        if out.len() != e.usize_ as usize || crc32(&out) != e.crc {
            return Err(format!("{name} の CRC が合わない"));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_known_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn roundtrip_store_and_deflate() {
        let mut w = ZipWriter::new();
        w.add("a.txt", b"hello", false);
        let big = vec![7u8; 10_000];
        w.add("dir/b.bin", &big, true);
        w.add("empty", b"", true);
        let bytes = w.finish();
        let r = ZipReader::new(&bytes).unwrap();
        assert_eq!(r.names(), vec!["a.txt", "dir/b.bin", "empty"]);
        assert_eq!(r.read("a.txt").unwrap(), b"hello");
        assert_eq!(r.read("dir/b.bin").unwrap(), big);
        assert_eq!(r.read("empty").unwrap(), b"");
        assert!(r.read("nope").is_err());
        assert!(bytes.len() < 10_000, "deflate が効いている");
    }

    #[test]
    fn rejects_garbage() {
        assert!(ZipReader::new(b"not a zip at all").is_err());
        assert!(ZipReader::new(b"").is_err());
    }
}
