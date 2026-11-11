#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>

#define EXIT_USAGE 0x4D4B0001u
#define EXIT_PIPE_UNAVAILABLE 0x4D4B0002u
#define EXIT_NAME_TAKEN 0x4D4B0003u
#define EXIT_CONTAINMENT_UNAVAILABLE 0x4D4B0004u
#define EXIT_MARKER_UNAVAILABLE 0x4D4B0005u
#define EXIT_LAUNCH_FAILED 0x4D4B0006u
#define EXIT_JOB_ABSENT 0x4D4B0007u
#define EXIT_OWNER_LOST 0x4D4B0008u
#define EXIT_TERMINATED 0x4D4B0009u

#define KEY_JOB 1
#define KEY_MEMBERS 2
#define KEY_TERMINATE 3
#define KEY_OWNER_LOST 4
#define KEY_COMMAND_EXIT 5

#define RECHECK_MS 100
#define REQUEST_LINE_LIMIT 64
#define NUMBER_TEXT_LIMIT 11
#define STANDARD_DESCRIPTORS 3
#define DESCRIPTOR_OPEN 0x01
#define RESERVED_SIZE_LIMIT 0xFFFFu

typedef struct {
  DWORD count;
  const BYTE *flags;
  const BYTE *handles;
} DESCRIPTOR_BLOCK;

static HANDLE g_pipe = INVALID_HANDLE_VALUE;
static HANDLE g_port = NULL;
static HANDLE g_job = NULL;
static BOOL g_pipe_open = FALSE;

static void *allocate(SIZE_T size) {
  void *memory = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size);
  if (memory == NULL) ExitProcess(EXIT_CONTAINMENT_UNAVAILABLE);
  return memory;
}

static void release(void *memory) {
  HeapFree(GetProcessHeap(), 0, memory);
}

static DWORD put_text(char *out, const char *text) {
  DWORD length = 0;
  while (text[length] != 0) {
    out[length] = text[length];
    length += 1;
  }
  return length;
}

static DWORD put_number(char *out, DWORD value) {
  char digits[NUMBER_TEXT_LIMIT];
  DWORD count = 0;
  DWORD index;
  do {
    digits[count] = (char)('0' + value % 10);
    count += 1;
    value /= 10;
  } while (value != 0);
  for (index = 0; index < count; index += 1) out[index] = digits[count - 1 - index];
  return count;
}

static void pipe_write(const char *bytes, DWORD length) {
  OVERLAPPED overlapped;
  DWORD written = 0;
  DWORD sent = 0;
  if (!g_pipe_open) return;
  ZeroMemory(&overlapped, sizeof overlapped);
  overlapped.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (overlapped.hEvent == NULL) {
    g_pipe_open = FALSE;
    return;
  }
  while (sent < length) {
    ResetEvent(overlapped.hEvent);
    if (!WriteFile(g_pipe, bytes + sent, length - sent, &written, &overlapped)) {
      if (GetLastError() != ERROR_IO_PENDING || !GetOverlappedResult(g_pipe, &overlapped, &written, TRUE)) {
        g_pipe_open = FALSE;
        break;
      }
    }
    sent += written;
  }
  CloseHandle(overlapped.hEvent);
}

static void say(const char *word) {
  char line[REQUEST_LINE_LIMIT];
  DWORD length = put_text(line, word);
  line[length] = '\n';
  pipe_write(line, length + 1);
}

static void say_number(const char *word, DWORD value) {
  char line[REQUEST_LINE_LIMIT];
  DWORD length = put_text(line, word);
  line[length] = ' ';
  length += 1;
  length += put_number(line + length, value);
  line[length] = '\n';
  pipe_write(line, length + 1);
}

static void say_started(DWORD pid, const DWORD *descriptors, DWORD count) {
  char *line = allocate(REQUEST_LINE_LIMIT + (SIZE_T)count * (NUMBER_TEXT_LIMIT + 1));
  DWORD length = put_text(line, "started ");
  DWORD index;
  length += put_number(line + length, pid);
  for (index = 0; index < count; index += 1) {
    line[length] = ' ';
    length += 1;
    length += put_number(line + length, descriptors[index]);
  }
  line[length] = '\n';
  pipe_write(line, length + 1);
  release(line);
}

static DECLSPEC_NORETURN void fail(const char *reason, DWORD exit_code, DWORD system_error) {
  char line[REQUEST_LINE_LIMIT * 2];
  DWORD length = put_text(line, "failed ");
  length += put_text(line + length, reason);
  line[length] = ' ';
  length += 1;
  length += put_number(line + length, system_error);
  line[length] = '\n';
  pipe_write(line, length + 1);
  if (g_pipe_open) FlushFileBuffers(g_pipe);
  ExitProcess(exit_code);
}

static JOBOBJECT_BASIC_PROCESS_ID_LIST *list_members(void) {
  DWORD capacity = 64;
  for (;;) {
    DWORD size = (DWORD)(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + capacity * sizeof(ULONG_PTR));
    JOBOBJECT_BASIC_PROCESS_ID_LIST *list = allocate(size);
    if (QueryInformationJobObject(g_job, JobObjectBasicProcessIdList, list, size, NULL)) {
      if (list->NumberOfProcessIdsInList >= list->NumberOfAssignedProcesses) return list;
    } else if (GetLastError() != ERROR_MORE_DATA) {
      ExitProcess(EXIT_CONTAINMENT_UNAVAILABLE);
    }
    release(list);
    capacity *= 2;
  }
}

static DWORD count_others(void) {
  JOBOBJECT_BASIC_PROCESS_ID_LIST *list = list_members();
  DWORD self = GetCurrentProcessId();
  DWORD others = 0;
  DWORD index;
  for (index = 0; index < list->NumberOfProcessIdsInList; index += 1) {
    if ((DWORD)list->ProcessIdList[index] != self) others += 1;
  }
  release(list);
  return others;
}

static void say_members(DWORD request) {
  JOBOBJECT_BASIC_PROCESS_ID_LIST *list = list_members();
  DWORD self = GetCurrentProcessId();
  char *line = allocate(REQUEST_LINE_LIMIT + (SIZE_T)list->NumberOfProcessIdsInList * (NUMBER_TEXT_LIMIT + 1));
  DWORD length = put_text(line, "members ");
  DWORD index;
  length += put_number(line + length, request);
  for (index = 0; index < list->NumberOfProcessIdsInList; index += 1) {
    DWORD pid = (DWORD)list->ProcessIdList[index];
    if (pid == self) continue;
    line[length] = ' ';
    length += 1;
    length += put_number(line + length, pid);
  }
  line[length] = '\n';
  pipe_write(line, length + 1);
  release(line);
  release(list);
}

static void terminate_job(void) {
  if (!TerminateJobObject(g_job, EXIT_TERMINATED)) ExitProcess(EXIT_CONTAINMENT_UNAVAILABLE);
  ExitProcess(EXIT_TERMINATED);
}

static BOOL parse_number(const char *text, DWORD length, DWORD *value) {
  DWORD index;
  unsigned long long total = 0;
  if (length == 0 || length >= NUMBER_TEXT_LIMIT) return FALSE;
  for (index = 0; index < length; index += 1) {
    if (text[index] < '0' || text[index] > '9') return FALSE;
    total = total * 10 + (unsigned long long)(text[index] - '0');
  }
  if (total > 0xFFFFFFFFull) return FALSE;
  *value = (DWORD)total;
  return TRUE;
}

static BOOL starts_with(const char *line, DWORD length, const char *word, DWORD word_length) {
  DWORD index;
  if (length < word_length) return FALSE;
  for (index = 0; index < word_length; index += 1) {
    if (line[index] != word[index]) return FALSE;
  }
  return TRUE;
}

static BOOL post_request(const char *line, DWORD length) {
  DWORD request = 0;
  if (length == 9 && starts_with(line, length, "terminate", 9)) return PostQueuedCompletionStatus(g_port, 0, KEY_TERMINATE, NULL);
  if (starts_with(line, length, "members ", 8) && parse_number(line + 8, length - 8, &request)) return PostQueuedCompletionStatus(g_port, request, KEY_MEMBERS, NULL);
  return FALSE;
}

static DWORD WINAPI read_requests(LPVOID unused) {
  char chunk[256];
  char line[REQUEST_LINE_LIMIT];
  DWORD held = 0;
  BOOL reading = TRUE;
  OVERLAPPED overlapped;
  (void)unused;
  ZeroMemory(&overlapped, sizeof overlapped);
  overlapped.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  while (reading && overlapped.hEvent != NULL) {
    DWORD got = 0;
    DWORD index;
    ResetEvent(overlapped.hEvent);
    if (!ReadFile(g_pipe, chunk, sizeof chunk, &got, &overlapped)) {
      if (GetLastError() != ERROR_IO_PENDING || !GetOverlappedResult(g_pipe, &overlapped, &got, TRUE)) break;
    }
    if (got == 0) break;
    for (index = 0; index < got && reading; index += 1) {
      if (chunk[index] == '\n') {
        reading = post_request(line, held);
        held = 0;
      } else if (held < sizeof line) {
        line[held] = chunk[index];
        held += 1;
      } else {
        reading = FALSE;
      }
    }
  }
  PostQueuedCompletionStatus(g_port, 0, KEY_OWNER_LOST, NULL);
  return 0;
}

static DWORD WINAPI wait_for_command(LPVOID command) {
  DWORD code = EXIT_LAUNCH_FAILED;
  WaitForSingleObject((HANDLE)command, INFINITE);
  GetExitCodeProcess((HANDLE)command, &code);
  PostQueuedCompletionStatus(g_port, code, KEY_COMMAND_EXIT, NULL);
  return 0;
}

static DWORD serve(BOOL member, BOOL terminate_on_owner_loss, BOOL command_exited) {
  DWORD command_code = 0;
  for (;;) {
    DWORD value = 0;
    ULONG_PTR key = 0;
    LPOVERLAPPED overlapped = NULL;
    if (GetQueuedCompletionStatus(g_port, &value, &key, &overlapped, RECHECK_MS)) {
      if (key == KEY_MEMBERS) say_members(value);
      if (key == KEY_TERMINATE) terminate_job();
      if (key == KEY_COMMAND_EXIT) {
        command_exited = TRUE;
        command_code = value;
        say_number("exit", value);
      }
      if (key == KEY_OWNER_LOST) {
        g_pipe_open = FALSE;
        if (!member) return 0;
        if (terminate_on_owner_loss) {
          TerminateJobObject(g_job, EXIT_OWNER_LOST);
          return EXIT_OWNER_LOST;
        }
      }
    }
    if (command_exited && count_others() == 0) {
      say("empty");
      if (g_pipe_open) FlushFileBuffers(g_pipe);
      return command_code;
    }
  }
}

static WCHAR *after_program(WCHAR *cursor) {
  if (*cursor == L'"') {
    cursor += 1;
    while (*cursor != 0 && *cursor != L'"') cursor += 1;
    if (*cursor != 0) cursor += 1;
  }
  while (*cursor != 0 && *cursor != L' ' && *cursor != L'\t') cursor += 1;
  return cursor;
}

static WCHAR *after_blanks(WCHAR *cursor) {
  while (*cursor == L' ' || *cursor == L'\t') cursor += 1;
  return cursor;
}

static WCHAR *take_word(WCHAR **cursor) {
  WCHAR *word = after_blanks(*cursor);
  WCHAR *end = word;
  if (*word == 0) ExitProcess(EXIT_USAGE);
  while (*end != 0 && *end != L' ' && *end != L'\t') end += 1;
  if (*end != 0) {
    *end = 0;
    end += 1;
  }
  *cursor = end;
  return word;
}

static BOOL same(const WCHAR *left, const WCHAR *right) {
  return lstrcmpW(left, right) == 0;
}

static void connect_pipe(const WCHAR *name) {
  g_pipe = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
  if (g_pipe == INVALID_HANDLE_VALUE) ExitProcess(EXIT_PIPE_UNAVAILABLE);
  g_pipe_open = TRUE;
  g_port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
  if (g_port == NULL) fail("launch-failed", EXIT_LAUNCH_FAILED, GetLastError());
}

static PSECURITY_DESCRIPTOR owner_only_descriptor(void) {
  HANDLE token = NULL;
  DWORD size = 0;
  TOKEN_USER *user;
  LPWSTR sid = NULL;
  WCHAR text[512];
  PSECURITY_DESCRIPTOR descriptor = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) fail("launch-failed", EXIT_LAUNCH_FAILED, GetLastError());
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  user = allocate(size);
  if (!GetTokenInformation(token, TokenUser, user, size, &size)) fail("launch-failed", EXIT_LAUNCH_FAILED, GetLastError());
  if (!ConvertSidToStringSidW(user->User.Sid, &sid)) fail("launch-failed", EXIT_LAUNCH_FAILED, GetLastError());
  if (lstrlenW(sid) > 256) fail("launch-failed", EXIT_LAUNCH_FAILED, ERROR_INVALID_SID);
  lstrcpyW(text, L"O:");
  lstrcatW(text, sid);
  lstrcatW(text, L"D:P(A;;GA;;;");
  lstrcatW(text, sid);
  lstrcatW(text, L")");
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(text, SDDL_REVISION_1, &descriptor, NULL)) fail("launch-failed", EXIT_LAUNCH_FAILED, GetLastError());
  LocalFree(sid);
  release(user);
  CloseHandle(token);
  return descriptor;
}

static void create_job(const WCHAR *name) {
  SECURITY_ATTRIBUTES attributes;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT association;
  DWORD error;
  ZeroMemory(&attributes, sizeof attributes);
  attributes.nLength = sizeof attributes;
  attributes.lpSecurityDescriptor = owner_only_descriptor();
  attributes.bInheritHandle = FALSE;
  SetLastError(ERROR_SUCCESS);
  g_job = CreateJobObjectW(&attributes, name);
  error = GetLastError();
  if (error == ERROR_ALREADY_EXISTS || (g_job == NULL && error == ERROR_ACCESS_DENIED)) fail("name-taken", EXIT_NAME_TAKEN, error);
  if (g_job == NULL) fail("containment-unavailable", EXIT_CONTAINMENT_UNAVAILABLE, error);
  ZeroMemory(&limits, sizeof limits);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) fail("containment-unavailable", EXIT_CONTAINMENT_UNAVAILABLE, GetLastError());
  association.CompletionKey = (PVOID)(ULONG_PTR)KEY_JOB;
  association.CompletionPort = g_port;
  if (!SetInformationJobObject(g_job, JobObjectAssociateCompletionPortInformation, &association, sizeof association)) fail("containment-unavailable", EXIT_CONTAINMENT_UNAVAILABLE, GetLastError());
  if (!AssignProcessToJobObject(g_job, GetCurrentProcess())) fail("containment-unavailable", EXIT_CONTAINMENT_UNAVAILABLE, GetLastError());
}

static int hex_digit(WCHAR character) {
  if (character >= L'0' && character <= L'9') return character - L'0';
  if (character >= L'a' && character <= L'f') return character - L'a' + 10;
  return -1;
}

static HANDLE open_marker(const WCHAR *hex) {
  SECURITY_ATTRIBUTES attributes;
  int length = lstrlenW(hex);
  int bytes = length / 2;
  char *utf8;
  WCHAR *path;
  int index;
  int wide;
  HANDLE marker;
  if (length == 0 || length % 2 != 0) ExitProcess(EXIT_USAGE);
  utf8 = allocate((SIZE_T)bytes);
  for (index = 0; index < bytes; index += 1) {
    int high = hex_digit(hex[index * 2]);
    int low = hex_digit(hex[index * 2 + 1]);
    if (high < 0 || low < 0) ExitProcess(EXIT_USAGE);
    utf8[index] = (char)(high * 16 + low);
  }
  wide = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, bytes, NULL, 0);
  if (wide <= 0) ExitProcess(EXIT_USAGE);
  path = allocate(((SIZE_T)wide + 1) * sizeof(WCHAR));
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, bytes, path, wide);
  ZeroMemory(&attributes, sizeof attributes);
  attributes.nLength = sizeof attributes;
  attributes.bInheritHandle = TRUE;
  marker = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &attributes, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (marker == INVALID_HANDLE_VALUE) fail("marker-unavailable", EXIT_MARKER_UNAVAILABLE, GetLastError());
  release(path);
  release(utf8);
  return marker;
}

static DWORD add_inherited(HANDLE *handles, DWORD count, HANDLE handle) {
  DWORD index;
  if (handle == NULL || handle == INVALID_HANDLE_VALUE) return count;
  for (index = 0; index < count; index += 1) {
    if (handles[index] == handle) return count;
  }
  if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) return count;
  handles[count] = handle;
  return count + 1;
}

static BOOL listed(const HANDLE *handles, DWORD count, HANDLE handle) {
  DWORD index;
  for (index = 0; index < count; index += 1) {
    if (handles[index] == handle) return TRUE;
  }
  return FALSE;
}

static BOOL parse_descriptors(const WCHAR *word, DWORD *descriptors, DWORD *count) {
  DWORD value = 0;
  BOOL digits = FALSE;
  *count = 0;
  if (same(word, L"-")) return TRUE;
  for (;; word += 1) {
    if (*word >= L'0' && *word <= L'9') {
      value = value * 10 + (DWORD)(*word - L'0');
      if (value > RESERVED_SIZE_LIMIT) return FALSE;
      digits = TRUE;
    } else if ((*word == L',' || *word == 0) && digits) {
      descriptors[*count] = value;
      *count += 1;
      value = 0;
      digits = FALSE;
      if (*word == 0) return TRUE;
    } else {
      return FALSE;
    }
  }
}

static DESCRIPTOR_BLOCK own_descriptor_block(void) {
  STARTUPINFOW own;
  DESCRIPTOR_BLOCK block;
  int declared = 0;
  ZeroMemory(&block, sizeof block);
  ZeroMemory(&own, sizeof own);
  own.cb = sizeof own;
  GetStartupInfoW(&own);
  if (own.lpReserved2 == NULL || own.cbReserved2 < sizeof declared) return block;
  CopyMemory(&declared, own.lpReserved2, sizeof declared);
  if (declared <= 0 || (SIZE_T)declared > (own.cbReserved2 - sizeof declared) / (1 + sizeof(HANDLE))) return block;
  block.count = (DWORD)declared;
  block.flags = own.lpReserved2 + sizeof declared;
  block.handles = block.flags + block.count;
  return block;
}

static HANDLE descriptor_handle(const DESCRIPTOR_BLOCK *block, DWORD descriptor) {
  HANDLE handle;
  CopyMemory(&handle, block->handles + (SIZE_T)descriptor * sizeof handle, sizeof handle);
  return handle;
}

static void put_descriptor(BYTE *block, DWORD count, DWORD descriptor, BYTE flags, HANDLE handle) {
  BYTE *slots = block + sizeof(int) + count;
  block[sizeof(int) + descriptor] = flags;
  CopyMemory(slots + (SIZE_T)descriptor * sizeof handle, &handle, sizeof handle);
}

static BOOL is_absolute(const WCHAR *path) {
  BOOL drive = ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) && path[1] == L':' && path[2] == L'\\';
  BOOL share = path[0] == L'\\' && path[1] == L'\\';
  return drive || share;
}

static WCHAR *absolute_program(const WCHAR *command_line) {
  const WCHAR *start = command_line;
  const WCHAR *end;
  WCHAR *program;
  SIZE_T length;
  if (*start == L'"') {
    start += 1;
    end = start;
    while (*end != 0 && *end != L'"') end += 1;
  } else {
    end = start;
    while (*end != 0 && *end != L' ' && *end != L'\t') end += 1;
  }
  length = (SIZE_T)(end - start);
  program = allocate((length + 1) * sizeof(WCHAR));
  CopyMemory(program, start, length * sizeof(WCHAR));
  program[length] = 0;
  if (!is_absolute(program)) fail("launch-failed", EXIT_LAUNCH_FAILED, ERROR_BAD_PATHNAME);
  return program;
}

static HANDLE start_command(WCHAR *command_line, HANDLE marker, const DWORD *descriptors, DWORD descriptor_count, DWORD *pid) {
  STARTUPINFOEXW startup;
  PROCESS_INFORMATION started;
  DESCRIPTOR_BLOCK own = own_descriptor_block();
  HANDLE *handles = allocate((STANDARD_DESCRIPTORS + 1 + (SIZE_T)descriptor_count) * sizeof(HANDLE));
  HANDLE standard[STANDARD_DESCRIPTORS];
  BYTE *block = NULL;
  WCHAR *program;
  DWORD block_size = 0;
  DWORD count = 0;
  DWORD index;
  SIZE_T size = 0;
  ZeroMemory(&startup, sizeof startup);
  ZeroMemory(&started, sizeof started);
  startup.StartupInfo.cb = sizeof startup;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  count = add_inherited(handles, count, startup.StartupInfo.hStdInput);
  count = add_inherited(handles, count, startup.StartupInfo.hStdOutput);
  count = add_inherited(handles, count, startup.StartupInfo.hStdError);
  count = add_inherited(handles, count, marker);
  if (own.count > 0) {
    int declared = (int)own.count;
    block_size = (DWORD)(sizeof declared + (SIZE_T)own.count * (1 + sizeof(HANDLE)));
    block = allocate(block_size);
    CopyMemory(block, &declared, sizeof declared);
    for (index = 0; index < own.count; index += 1) put_descriptor(block, own.count, index, 0, INVALID_HANDLE_VALUE);
    standard[0] = startup.StartupInfo.hStdInput;
    standard[1] = startup.StartupInfo.hStdOutput;
    standard[2] = startup.StartupInfo.hStdError;
    for (index = 0; index < STANDARD_DESCRIPTORS && index < own.count; index += 1) put_descriptor(block, own.count, index, own.flags[index], standard[index]);
  }
  for (index = 0; index < descriptor_count; index += 1) {
    DWORD descriptor = descriptors[index];
    HANDLE handle;
    if (descriptor < STANDARD_DESCRIPTORS || descriptor >= own.count || (own.flags[descriptor] & DESCRIPTOR_OPEN) == 0) fail("launch-failed", EXIT_LAUNCH_FAILED, ERROR_INVALID_HANDLE);
    handle = descriptor_handle(&own, descriptor);
    SetLastError(ERROR_INVALID_HANDLE);
    count = add_inherited(handles, count, handle);
    if (!listed(handles, count, handle)) fail("launch-failed", EXIT_LAUNCH_FAILED, GetLastError());
    put_descriptor(block, own.count, descriptor, own.flags[descriptor], handle);
  }
  startup.StartupInfo.cbReserved2 = (WORD)block_size;
  startup.StartupInfo.lpReserved2 = block;
  if (count > 0) {
    InitializeProcThreadAttributeList(NULL, 1, 0, &size);
    startup.lpAttributeList = allocate(size);
    if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &size)) fail("launch-failed", EXIT_LAUNCH_FAILED, GetLastError());
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, count * sizeof(HANDLE), NULL, NULL)) fail("launch-failed", EXIT_LAUNCH_FAILED, GetLastError());
  }
  program = absolute_program(command_line);
  if (!CreateProcessW(program, command_line, NULL, NULL, count > 0, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, NULL, NULL, &startup.StartupInfo, &started)) fail("launch-failed", EXIT_LAUNCH_FAILED, GetLastError());
  release(program);
  CloseHandle(started.hThread);
  for (index = 0; index < descriptor_count; index += 1) CloseHandle(descriptor_handle(&own, descriptors[index]));
  if (startup.lpAttributeList != NULL) {
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    release(startup.lpAttributeList);
  }
  if (block != NULL) release(block);
  release(handles);
  *pid = started.dwProcessId;
  return started.hProcess;
}

static void start_thread(LPTHREAD_START_ROUTINE routine, LPVOID argument) {
  HANDLE thread = CreateThread(NULL, 0, routine, argument, 0, NULL);
  if (thread == NULL) {
    TerminateJobObject(g_job, EXIT_CONTAINMENT_UNAVAILABLE);
    ExitProcess(EXIT_CONTAINMENT_UNAVAILABLE);
  }
  CloseHandle(thread);
}

static DWORD launch(WCHAR *cursor) {
  WCHAR *pipe = take_word(&cursor);
  WCHAR *job = take_word(&cursor);
  WCHAR *owner_loss = take_word(&cursor);
  WCHAR *marker_word = take_word(&cursor);
  WCHAR *descriptor_word = take_word(&cursor);
  WCHAR *separator = take_word(&cursor);
  WCHAR *command_line = after_blanks(cursor);
  BOOL terminate_on_owner_loss = same(owner_loss, L"terminate");
  DWORD *descriptors = allocate(((SIZE_T)lstrlenW(descriptor_word) + 1) * sizeof(DWORD));
  DWORD descriptor_count = 0;
  HANDLE marker = NULL;
  HANDLE command;
  DWORD pid = 0;
  if (!terminate_on_owner_loss && !same(owner_loss, L"persist")) return EXIT_USAGE;
  if (!same(separator, L"--") || *command_line == 0) return EXIT_USAGE;
  if (!parse_descriptors(descriptor_word, descriptors, &descriptor_count)) return EXIT_USAGE;
  connect_pipe(pipe);
  create_job(job);
  if (!same(marker_word, L"-")) marker = open_marker(marker_word);
  command = start_command(command_line, marker, descriptors, descriptor_count, &pid);
  say_started(pid, descriptors, descriptor_count);
  release(descriptors);
  start_thread(wait_for_command, command);
  start_thread(read_requests, NULL);
  return serve(TRUE, terminate_on_owner_loss, FALSE);
}

static DWORD attach(WCHAR *cursor) {
  WCHAR *pipe = take_word(&cursor);
  WCHAR *job = take_word(&cursor);
  DWORD error;
  connect_pipe(pipe);
  g_job = OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE | JOB_OBJECT_SET_ATTRIBUTES, FALSE, job);
  error = GetLastError();
  if (g_job == NULL && error == ERROR_FILE_NOT_FOUND) fail("job-absent", EXIT_JOB_ABSENT, error);
  if (g_job == NULL) fail("launch-failed", EXIT_LAUNCH_FAILED, error);
  say("attached");
  start_thread(read_requests, NULL);
  return serve(FALSE, FALSE, TRUE);
}

int wmain(void) {
  const WCHAR *original = GetCommandLineW();
  WCHAR *copy = allocate(((SIZE_T)lstrlenW(original) + 1) * sizeof(WCHAR));
  WCHAR *cursor;
  WCHAR *mode;
  lstrcpyW(copy, original);
  cursor = after_program(copy);
  mode = take_word(&cursor);
  if (same(mode, L"launch")) ExitProcess(launch(cursor));
  if (same(mode, L"attach")) ExitProcess(attach(cursor));
  ExitProcess(EXIT_USAGE);
}
