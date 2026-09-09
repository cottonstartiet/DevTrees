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

pub struct ProcessScope {
    #[cfg(windows)]
    handle: usize,
}

impl ProcessScope {
    pub fn attach(child: &tokio::process::Child) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use winapi::um::{
                handleapi::CloseHandle,
                jobapi2::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject},
                winnt::{
                    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
            };
            let child_handle = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("Copilot process handle is unavailable."))?;
            // The job handle is exclusively owned by this scope. Closing it kills only
            // the managed child and descendants, never independent external terminals.
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &mut limits as *mut _ as *mut _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                    || AssignProcessToJobObject(handle, child_handle as *mut _) == 0
                {
                    let error = io::Error::last_os_error();
                    CloseHandle(handle);
                    return Err(error);
                }
                Ok(Self {
                    handle: handle as usize,
                })
            }
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(Self {})
        }
    }
}

impl Drop for ProcessScope {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            winapi::um::handleapi::CloseHandle(self.handle as *mut _);
        }
    }
}
