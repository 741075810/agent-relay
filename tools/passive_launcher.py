"""Dedicated finite launcher; witnesses only its own observer child's exit.

No daemon, elevation, browser/host/service calls or retry. Scheduler may own this
launcher. A Windows job closes only this child tree; exit FILETIME is kernel data.
"""
import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
import sys

try:
    from tools import passive_observer as observer
    from tools import release_gate
except ModuleNotFoundError:
    import passive_observer as observer
    import release_gate


def exit_time(proc):
    if os.name!='nt': return 'UNKNOWN'
    k=ctypes.WinDLL('kernel32',use_last_error=True)
    created,exited,kernel,user=(wintypes.FILETIME() for _ in range(4))
    if not k.GetProcessTimes(wintypes.HANDLE(int(proc._handle)),ctypes.byref(created),
                            ctypes.byref(exited),ctypes.byref(kernel),ctypes.byref(user)):
        return 'UNKNOWN'
    ticks=(exited.dwHighDateTime<<32)|exited.dwLowDateTime
    return observer.utc((ticks-116444736000000000)/10000000) if ticks else 'UNKNOWN'


def main(argv=None):
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--config',required=True); ap.add_argument('--out',required=True)
    ap.add_argument('--seconds',type=int,default=86400); ap.add_argument('--interval',type=int,default=30)
    a=ap.parse_args(argv)
    if not 1<=a.seconds<=86400 or not 1<=a.interval<=30: return 2
    options={'stdin':subprocess.DEVNULL,'stdout':subprocess.DEVNULL,'stderr':subprocess.DEVNULL}
    if os.name=='nt': options['creationflags']=subprocess.CREATE_NO_WINDOW
    else: options['start_new_session']=True
    proc=subprocess.Popen([sys.executable,'-B',str(Path(observer.__file__).resolve()),'--enable',
                           '--config',a.config,'--out',a.out,'--seconds',str(a.seconds),
                           '--interval',str(a.interval)],**options)
    job=release_gate._assign_job(proc) if os.name=='nt' else None
    proc._gate_job=job
    forced=False
    try:
        try: code=proc.wait(timeout=a.seconds+120)
        except subprocess.TimeoutExpired:
            forced=True; proc.kill(); code=proc.wait(timeout=10)
        receipt={'pid':proc.pid,'returncode':code,'forced_timeout':forced,
                 'exit_actual_at_utc':exit_time(proc),'exit_observed_at_utc':observer.utc(),
                 'scope':'own child handle only; no other process control'}
        root=Path(a.out)
        if root.is_dir(): observer.atomic(root/'exit-witness.json',receipt,True)
    finally:
        if job: release_gate._release_job(proc)
    return code


if __name__=='__main__':
    try: result=main()
    except Exception: result=2
    raise SystemExit(result)
