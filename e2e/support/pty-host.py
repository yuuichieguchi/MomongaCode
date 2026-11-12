import fcntl
import os
import pty
import select
import struct
import sys
import termios

columns, rows = int(sys.argv[1]), int(sys.argv[2])
command = sys.argv[3:]

pid, master = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
    os.execvp(command[0], command)

stdin = sys.stdin.fileno()
stdout = sys.stdout.fileno()
reading_stdin = True
while True:
    sources = [master, stdin] if reading_stdin else [master]
    ready, _, _ = select.select(sources, [], [])
    if master in ready:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        os.write(stdout, chunk)
    if reading_stdin and stdin in ready:
        chunk = os.read(stdin, 65536)
        if chunk:
            os.write(master, chunk)
        else:
            reading_stdin = False

_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
