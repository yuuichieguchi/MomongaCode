#define WIN32_LEAN_AND_MEAN
#include <windows.h>

static WCHAR *after_program(WCHAR *cursor) {
  if (*cursor == L'"') {
    cursor += 1;
    while (*cursor != 0 && *cursor != L'"') cursor += 1;
    if (*cursor != 0) cursor += 1;
  }
  while (*cursor != 0 && *cursor != L' ' && *cursor != L'\t') cursor += 1;
  while (*cursor == L' ' || *cursor == L'\t') cursor += 1;
  return cursor;
}

int wmain(void) {
  JOBOBJECT_BASIC_UI_RESTRICTIONS restrictions;
  STARTUPINFOW startup;
  PROCESS_INFORMATION started;
  DWORD code = 1;
  HANDLE job = CreateJobObjectW(NULL, NULL);
  WCHAR *command_line = after_program(GetCommandLineW());
  if (job == NULL || *command_line == 0) ExitProcess(2);
  restrictions.UIRestrictionsClass = JOB_OBJECT_UILIMIT_HANDLES;
  if (!SetInformationJobObject(job, JobObjectBasicUIRestrictions, &restrictions, sizeof restrictions)) ExitProcess(3);
  if (!AssignProcessToJobObject(job, GetCurrentProcess())) ExitProcess(4);
  ZeroMemory(&startup, sizeof startup);
  ZeroMemory(&started, sizeof started);
  startup.cb = sizeof startup;
  if (!CreateProcessW(NULL, command_line, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &started)) ExitProcess(5);
  WaitForSingleObject(started.hProcess, INFINITE);
  GetExitCodeProcess(started.hProcess, &code);
  ExitProcess(code);
}
