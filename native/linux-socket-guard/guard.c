#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/filter.h>
#include <linux/openat2.h>
#include <linux/seccomp.h>
#include <pthread.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
#ifndef SYS_openat2
#define SYS_openat2 437
#endif
#ifndef SYS_pidfd_getfd
#define SYS_pidfd_getfd 438
#endif
#ifndef SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV
#define SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV (1UL << 5)
#endif

#define PROGRAM_NAME "momonga-socket-guard"
#define EXIT_NOT_STARTED 126
#define EXIT_USAGE 64
#define FILTER_BYTES_MAX (BPF_MAXINSNS * sizeof(struct sock_filter))
#define HANDSHAKE_BYTES 32
#define ANSWER_STACK_BYTES (256 * 1024)
#define ACKNOWLEDGED 'k'

struct path_list {
  char **entries;
  size_t count;
};

struct service {
  int channel;
  struct path_list allowed;
  struct path_list denied;
};

struct question {
  int listener;
  const struct service *service;
  struct seccomp_notif_sizes sizes;
  struct seccomp_notif *request;
};

static void complain(const char *what) {
  dprintf(STDERR_FILENO, "%s: %s: %s\n", PROGRAM_NAME, what, strerror(errno));
}

static void say(const char *what) {
  dprintf(STDERR_FILENO, "%s: %s\n", PROGRAM_NAME, what);
}

static int parse_descriptor(const char *text, int *descriptor) {
  char *end = NULL;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value < 0 || value > INT_MAX) return -1;
  *descriptor = (int)value;
  return 0;
}

static int write_all(int descriptor, const char *bytes, size_t length) {
  size_t done = 0;
  while (done < length) {
    ssize_t wrote = write(descriptor, bytes + done, length - done);
    if (wrote < 0 && errno == EINTR) continue;
    if (wrote <= 0) return -1;
    done += (size_t)wrote;
  }
  return 0;
}

static ssize_t read_filter(int descriptor, unsigned char *bytes, size_t capacity) {
  size_t done = 0;
  for (;;) {
    if (done == capacity) {
      char extra;
      ssize_t more = read(descriptor, &extra, 1);
      if (more < 0 && errno == EINTR) continue;
      if (more != 0) {
        errno = E2BIG;
        return -1;
      }
      return (ssize_t)done;
    }
    ssize_t got = read(descriptor, bytes + done, capacity - done);
    if (got < 0 && errno == EINTR) continue;
    if (got < 0) return -1;
    if (got == 0) return (ssize_t)done;
    done += (size_t)got;
  }
}

static int enter(int filter_descriptor, int channel, char **command) {
  static unsigned char bytes[FILTER_BYTES_MAX];
  ssize_t length = read_filter(filter_descriptor, bytes, sizeof bytes);
  if (length < 0) {
    complain("the socket filter could not be read");
    return EXIT_NOT_STARTED;
  }
  if (length == 0 || (size_t)length % sizeof(struct sock_filter) != 0) {
    say("the socket filter is not a whole number of instructions");
    return EXIT_NOT_STARTED;
  }
  close(filter_descriptor);
  struct sock_fprog program = {.len = (unsigned short)((size_t)length / sizeof(struct sock_filter)), .filter = (struct sock_filter *)bytes};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    complain("new privileges could not be given up");
    return EXIT_NOT_STARTED;
  }
  long listener = syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER | SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV, &program);
  if (listener < 0 && errno == EINVAL) listener = syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &program);
  if (listener < 0) {
    complain("the socket filter could not be installed");
    return EXIT_NOT_STARTED;
  }
  char line[HANDSHAKE_BYTES];
  int written = snprintf(line, sizeof line, "%ld\n", listener);
  if (write_all(channel, line, (size_t)written) != 0) {
    complain("the listener could not be announced to the guard");
    return EXIT_NOT_STARTED;
  }
  char acknowledgement = 0;
  ssize_t got;
  do {
    got = read(channel, &acknowledgement, 1);
  } while (got < 0 && errno == EINTR);
  if (got != 1 || acknowledgement != ACKNOWLEDGED) {
    say("the guard did not take the listener, so the command was not started");
    return EXIT_NOT_STARTED;
  }
  close((int)listener);
  close(channel);
  signal(SIGTERM, SIG_DFL);
  execvp(command[0], command);
  complain(command[0]);
  return errno == ENOENT ? 127 : EXIT_NOT_STARTED;
}

static int inside(const char *candidate, const char *directory) {
  size_t length = strlen(directory);
  if (length == 1 && directory[0] == '/') return candidate[0] == '/';
  return strncmp(candidate, directory, length) == 0 && (candidate[length] == '\0' || candidate[length] == '/');
}

static int inside_any(const char *candidate, const struct path_list *list) {
  for (size_t index = 0; index < list->count; index += 1) {
    if (inside(candidate, list->entries[index])) return 1;
  }
  return 0;
}

static pid_t leader_of(pid_t thread) {
  char file[64];
  snprintf(file, sizeof file, "/proc/%d/status", (int)thread);
  FILE *status = fopen(file, "re");
  if (status == NULL) return -1;
  char line[256];
  long leader = -1;
  while (fgets(line, sizeof line, status) != NULL) {
    if (strncmp(line, "Tgid:", 5) == 0) {
      leader = strtol(line + 5, NULL, 10);
      break;
    }
  }
  fclose(status);
  return leader > 0 ? (pid_t)leader : -1;
}

static int read_memory(pid_t thread, uint64_t address, void *into, size_t length) {
  char file[64];
  snprintf(file, sizeof file, "/proc/%d/mem", (int)thread);
  int memory = open(file, O_RDONLY | O_CLOEXEC);
  if (memory < 0) return -1;
  ssize_t got = pread(memory, into, length, (off_t)address);
  close(memory);
  return got == (ssize_t)length ? 0 : -1;
}

static int working_directory_of(pid_t thread, char *into, size_t capacity) {
  char file[64];
  snprintf(file, sizeof file, "/proc/%d/cwd", (int)thread);
  int directory = open(file, O_PATH | O_CLOEXEC);
  if (directory < 0) return -1;
  char link[64];
  snprintf(link, sizeof link, "/proc/self/fd/%d", directory);
  ssize_t length = readlink(link, into, capacity - 1);
  close(directory);
  if (length <= 0 || into[0] != '/') return -1;
  into[length] = '\0';
  return 0;
}

static int connect_named(const struct service *service, int socket_copy, pid_t thread, const struct sockaddr_storage *address, size_t length) {
  const struct sockaddr_un *name = (const struct sockaddr_un *)address;
  size_t offset = offsetof(struct sockaddr_un, sun_path);
  if (length <= offset || name->sun_family != AF_UNIX || name->sun_path[0] == '\0') return -EPERM;
  char requested[sizeof name->sun_path + 1];
  size_t text_length = strnlen(name->sun_path, length - offset);
  memcpy(requested, name->sun_path, text_length);
  requested[text_length] = '\0';
  char absolute[PATH_MAX];
  if (requested[0] == '/') {
    snprintf(absolute, sizeof absolute, "%s", requested);
  } else {
    char base[PATH_MAX];
    if (working_directory_of(thread, base, sizeof base) != 0) return -EPERM;
    if ((size_t)snprintf(absolute, sizeof absolute, "%s/%s", base, requested) >= sizeof absolute) return -EPERM;
  }
  char real[PATH_MAX];
  if (realpath(absolute, real) == NULL) {
    int reason = errno;
    return inside_any(absolute, &service->allowed) && !inside_any(absolute, &service->denied) ? -reason : -EPERM;
  }
  if (inside_any(real, &service->denied) || !inside_any(real, &service->allowed)) return -EPERM;
  struct open_how how = {.flags = O_PATH | O_CLOEXEC, .resolve = RESOLVE_NO_SYMLINKS};
  long node = syscall(SYS_openat2, AT_FDCWD, real, &how, sizeof how);
  if (node < 0) return errno == ENOENT ? -ENOENT : -EPERM;
  struct sockaddr_un through = {.sun_family = AF_UNIX};
  snprintf(through.sun_path, sizeof through.sun_path, "/proc/self/fd/%ld", node);
  int result = connect(socket_copy, (const struct sockaddr *)&through, sizeof through) == 0 ? 0 : -errno;
  close((int)node);
  return result;
}

static int decide(const struct question *question) {
  const struct seccomp_notif *request = question->request;
  int number = request->data.nr;
  if (number != SYS_connect && number != SYS_bind) return -EPERM;
  int64_t given = (int32_t)request->data.args[2];
  struct sockaddr_storage address;
  if (given < 0 || (size_t)given > sizeof address) return -EINVAL;
  size_t length = (size_t)given;
  memset(&address, 0, sizeof address);
  pid_t thread = (pid_t)request->pid;
  pid_t leader = leader_of(thread);
  if (leader < 0) return -EPERM;
  if (length > 0 && read_memory(thread, request->data.args[1], &address, length) != 0) return -EFAULT;
  long process = syscall(SYS_pidfd_open, leader, 0);
  if (process < 0) return -EPERM;
  long socket_copy = syscall(SYS_pidfd_getfd, (int)process, (int)request->data.args[0], 0);
  int reason = errno;
  close((int)process);
  if (socket_copy < 0) return reason == EBADF ? -EBADF : -EPERM;
  int result;
  int domain = 0;
  socklen_t domain_length = sizeof domain;
  if (ioctl(question->listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &request->id) != 0) result = -EPERM;
  else if (getsockopt((int)socket_copy, SOL_SOCKET, SO_DOMAIN, &domain, &domain_length) != 0) result = -ENOTSOCK;
  else if (domain != AF_UNIX && number == SYS_connect) result = connect((int)socket_copy, (const struct sockaddr *)&address, (socklen_t)length) == 0 ? 0 : -errno;
  else if (domain != AF_UNIX) result = bind((int)socket_copy, (const struct sockaddr *)&address, (socklen_t)length) == 0 ? 0 : -errno;
  else if (number == SYS_bind) result = -EPERM;
  else result = connect_named(question->service, (int)socket_copy, thread, &address, length);
  close((int)socket_copy);
  return result;
}

static void *answer(void *given) {
  struct question *question = given;
  size_t size = question->sizes.seccomp_notif_resp > sizeof(struct seccomp_notif_resp) ? question->sizes.seccomp_notif_resp : sizeof(struct seccomp_notif_resp);
  struct seccomp_notif_resp *response = calloc(1, size);
  if (response != NULL) {
    response->id = question->request->id;
    response->error = decide(question);
    ioctl(question->listener, SECCOMP_IOCTL_NOTIF_SEND, response);
    free(response);
  }
  free(question->request);
  free(question);
  return NULL;
}

static int take_listener(int channel) {
  char text[HANDSHAKE_BYTES] = {0};
  char control[CMSG_SPACE(sizeof(struct ucred))];
  struct iovec part = {.iov_base = text, .iov_len = sizeof text - 1};
  struct msghdr message = {.msg_iov = &part, .msg_iovlen = 1, .msg_control = control, .msg_controllen = sizeof control};
  ssize_t got;
  do {
    got = recvmsg(channel, &message, MSG_CMSG_CLOEXEC);
  } while (got < 0 && errno == EINTR);
  if (got <= 0) return -1;
  pid_t sender = -1;
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  if (header != NULL && header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_CREDENTIALS) {
    struct ucred credentials;
    memcpy(&credentials, CMSG_DATA(header), sizeof credentials);
    sender = credentials.pid;
  }
  char *end = NULL;
  long number = strtol(text, &end, 10);
  if (sender <= 0 || end == text || *end != '\n' || number < 0 || number > INT_MAX) return -1;
  long process = syscall(SYS_pidfd_open, sender, 0);
  if (process < 0) return -1;
  long listener = syscall(SYS_pidfd_getfd, (int)process, (int)number, 0);
  close((int)process);
  return listener < 0 ? -1 : (int)listener;
}

static void *serve(void *given) {
  const struct service *service = given;
  int listener = take_listener(service->channel);
  if (listener < 0) {
    close(service->channel);
    return NULL;
  }
  char acknowledgement = ACKNOWLEDGED;
  int told = write_all(service->channel, &acknowledgement, 1);
  close(service->channel);
  if (told != 0) return NULL;
  struct seccomp_notif_sizes sizes;
  if (syscall(SYS_seccomp, SECCOMP_GET_NOTIF_SIZES, 0, &sizes) != 0) return NULL;
  size_t request_size = sizes.seccomp_notif > sizeof(struct seccomp_notif) ? sizes.seccomp_notif : sizeof(struct seccomp_notif);
  pthread_attr_t attributes;
  pthread_attr_init(&attributes);
  pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
  pthread_attr_setstacksize(&attributes, ANSWER_STACK_BYTES);
  for (;;) {
    struct question *question = calloc(1, sizeof *question);
    struct seccomp_notif *request = calloc(1, request_size);
    if (question == NULL || request == NULL) {
      free(question);
      free(request);
      return NULL;
    }
    if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, request) != 0) {
      int reason = errno;
      free(question);
      free(request);
      if (reason == EINTR || reason == ENOENT) continue;
      return NULL;
    }
    question->listener = listener;
    question->service = service;
    question->sizes = sizes;
    question->request = request;
    pthread_t worker;
    if (pthread_create(&worker, &attributes, answer, question) != 0) answer(question);
  }
}

static int supervise(int channel_slot, struct service *service, char **program) {
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) != 0) {
    complain("the channel to the sandbox could not be made");
    return EXIT_NOT_STARTED;
  }
  int enabled = 1;
  if (setsockopt(pair[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof enabled) != 0) {
    complain("the channel to the sandbox cannot carry the sender");
    return EXIT_NOT_STARTED;
  }
  pid_t guard = getpid();
  pid_t child = fork();
  if (child < 0) {
    complain("the sandbox could not be started");
    return EXIT_NOT_STARTED;
  }
  if (child == 0) {
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != guard) _exit(EXIT_NOT_STARTED);
    if (pair[1] == channel_slot) {
      if (fcntl(channel_slot, F_SETFD, 0) != 0) _exit(EXIT_NOT_STARTED);
    } else if (dup2(pair[1], channel_slot) < 0) {
      _exit(EXIT_NOT_STARTED);
    }
    signal(SIGTERM, SIG_IGN);
    execvp(program[0], program);
    complain(program[0]);
    _exit(errno == ENOENT ? 127 : EXIT_NOT_STARTED);
  }
  close(pair[1]);
  signal(SIGTERM, SIG_IGN);
  signal(SIGINT, SIG_IGN);
  signal(SIGHUP, SIG_IGN);
  signal(SIGPIPE, SIG_IGN);
  service->channel = pair[0];
  pthread_t server;
  if (pthread_create(&server, NULL, serve, service) != 0) {
    complain("the guard could not start answering");
    close(pair[0]);
  }
  int status = 0;
  pid_t waited;
  do {
    waited = waitpid(child, &status, 0);
  } while (waited < 0 && errno == EINTR);
  if (waited < 0) {
    complain("the sandbox could not be waited for");
    return EXIT_NOT_STARTED;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  signal(WTERMSIG(status), SIG_DFL);
  raise(WTERMSIG(status));
  return 128 + WTERMSIG(status);
}

static int usage(void) {
  say("usage: supervise <channel> [--allow <path>]... [--deny <path>]... -- <program> [argument]...");
  say("       enter <filter> <channel> -- <program> [argument]...");
  return EXIT_USAGE;
}

int main(int argc, char **argv) {
  if (argc >= 6 && strcmp(argv[1], "enter") == 0 && strcmp(argv[4], "--") == 0) {
    int filter_descriptor;
    int channel;
    if (parse_descriptor(argv[2], &filter_descriptor) != 0 || parse_descriptor(argv[3], &channel) != 0) return usage();
    return enter(filter_descriptor, channel, argv + 5);
  }
  if (argc >= 5 && strcmp(argv[1], "supervise") == 0) {
    int channel_slot;
    if (parse_descriptor(argv[2], &channel_slot) != 0) return usage();
    struct service service = {.channel = -1};
    service.allowed.entries = calloc((size_t)argc, sizeof(char *));
    service.denied.entries = calloc((size_t)argc, sizeof(char *));
    if (service.allowed.entries == NULL || service.denied.entries == NULL) return EXIT_NOT_STARTED;
    int index = 3;
    for (; index + 1 < argc && strcmp(argv[index], "--") != 0; index += 2) {
      struct path_list *list = strcmp(argv[index], "--allow") == 0 ? &service.allowed : strcmp(argv[index], "--deny") == 0 ? &service.denied : NULL;
      if (list == NULL || argv[index + 1][0] != '/') return usage();
      list->entries[list->count] = argv[index + 1];
      list->count += 1;
    }
    if (index + 1 >= argc || strcmp(argv[index], "--") != 0) return usage();
    return supervise(channel_slot, &service, argv + index + 1);
  }
  return usage();
}
