use std::io;

pub struct ProcessScope {
    #[cfg(windows)]
    handle: usize,
    #[cfg(unix)]
    pid: u32,
}

impl ProcessScope {
    pub fn attach_pid(pid: u32) -> io::Result<Self> {
        #[cfg(windows)]
        unsafe {
            use winapi::um::{
                handleapi::CloseHandle,
                processthreadsapi::OpenProcess,
                winnt::{PROCESS_SET_QUOTA, PROCESS_TERMINATE},
            };
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return Err(io::Error::last_os_error());
            }
            let result = Self::attach_handle(process);
            CloseHandle(process);
            result
        }
        #[cfg(unix)]
        {
            Ok(Self { pid })
        }
    }

    pub fn attach(child: &tokio::process::Child) -> io::Result<Self> {
        #[cfg(windows)]
        {
            Self::attach_handle(
                child
                    .raw_handle()
                    .ok_or_else(|| io::Error::other("The child process handle is unavailable."))?
                    as *mut _,
            )
        }
        #[cfg(unix)]
        {
            Ok(Self {
                pid: child
                    .id()
                    .ok_or_else(|| io::Error::other("The child process has exited."))?,
            })
        }
    }

    pub fn attach_blocking(child: &std::process::Child) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            Self::attach_handle(child.as_raw_handle() as *mut _)
        }
        #[cfg(unix)]
        {
            Ok(Self { pid: child.id() })
        }
    }

    /// Completed CLI commands may have intentionally detached helpers (for example
    /// a signing agent). Keep them alive when the command and both pipes finished.
    pub fn release(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        unsafe {
            use winapi::um::{
                jobapi2::SetInformationJobObject,
                winnt::{JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION},
            };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            if SetInformationJobObject(
                self.handle as *mut _,
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *mut _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        #[cfg(unix)]
        {
            self.pid = 0;
        }
        Ok(())
    }

    #[cfg(windows)]
    fn attach_handle(child: winapi::um::winnt::HANDLE) -> io::Result<Self> {
        use winapi::um::{
            handleapi::CloseHandle,
            jobapi2::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject},
            winnt::{
                JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };
        // The job owns only this invocation and its descendants, never independent terminals.
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
                || AssignProcessToJobObject(handle, child) == 0
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
}

impl Drop for ProcessScope {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            winapi::um::handleapi::CloseHandle(self.handle as *mut _);
        }
        #[cfg(unix)]
        unsafe {
            // Callers create a fresh process group before spawning.
            if self.pid != 0 {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
            }
        }
    }
}
