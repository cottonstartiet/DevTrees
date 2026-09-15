pub use crate::process::ProcessScope;
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, ReadBuf};

pub const MAX_FRAME_BYTES: usize = 24 * 1024 * 1024;

pub struct BoundedRead<R> {
    reader: R,
    line_bytes: usize,
}

impl<R> BoundedRead<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            line_bytes: 0,
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for BoundedRead<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        match Pin::new(&mut self.reader).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                for byte in &buf.filled()[before..] {
                    if *byte == b'\n' {
                        self.line_bytes = 0;
                    } else {
                        self.line_bytes += 1;
                        if self.line_bytes > MAX_FRAME_BYTES {
                            buf.set_filled(before);
                            return Poll::Ready(Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "Copilot exceeded the 24 MiB protocol-frame limit.",
                            )));
                        }
                    }
                }
                Poll::Ready(Ok(()))
            }
            result => result,
        }
    }
}
