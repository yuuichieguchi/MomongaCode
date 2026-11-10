#define WIN32_LEAN_AND_MEAN
#include <windows.h>

int wmain(int argc, WCHAR **argv) {
  HANDLE job;
  BOOL member = FALSE;
  if (argc != 2) ExitProcess(2);
  job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, argv[1]);
  if (job == NULL) ExitProcess(4);
  if (!IsProcessInJob(GetCurrentProcess(), job, &member)) ExitProcess(5);
  ExitProcess(member ? 0 : 3);
}
