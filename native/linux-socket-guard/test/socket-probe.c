#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static int report(int result) {
  if (result == 0) {
    puts("ok");
    return 0;
  }
  printf("%s\n", errno == EPERM ? "EPERM" : errno == ENOENT ? "ENOENT" : errno == ECONNREFUSED ? "ECONNREFUSED" : errno == ENOSYS ? "ENOSYS" : strerror(errno));
  return 1;
}

static socklen_t named(struct sockaddr_un *address, const char *path, int abstract) {
  memset(address, 0, sizeof *address);
  address->sun_family = AF_UNIX;
  size_t length = strlen(path);
  if (length + 1 + (size_t)abstract > sizeof address->sun_path) {
    fputs("the path is too long for a socket address\n", stderr);
    exit(2);
  }
  memcpy(address->sun_path + abstract, path, length);
  return (socklen_t)(offsetof(struct sockaddr_un, sun_path) + (size_t)abstract + length + (abstract ? 0 : 1));
}

static int exchange(int descriptor) {
  char reply[16] = {0};
  if (write(descriptor, "ping", 4) != 4) return -1;
  ssize_t got = read(descriptor, reply, sizeof reply - 1);
  if (got <= 0) return -1;
  printf("%s ", reply);
  return 0;
}

static int kind_of(const char *name) {
  if (strcmp(name, "stream") == 0) return SOCK_STREAM;
  if (strcmp(name, "datagram") == 0) return SOCK_DGRAM;
  if (strcmp(name, "raw") == 0) return SOCK_RAW;
  if (strcmp(name, "sequenced") == 0) return SOCK_SEQPACKET;
  fputs("unknown socket kind\n", stderr);
  exit(2);
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "socket") == 0) {
    int descriptor = socket(AF_UNIX, kind_of(argv[2]), 0);
    return report(descriptor < 0 ? -1 : 0);
  }
  if (argc == 3 && strcmp(argv[1], "pair") == 0) {
    int pair[2];
    if (socketpair(AF_UNIX, kind_of(argv[2]), 0, pair) != 0) return report(-1);
    char byte = 0;
    return report(write(pair[0], "x", 1) == 1 && read(pair[1], &byte, 1) == 1 && byte == 'x' ? 0 : -1);
  }
  if (argc == 3 && (strcmp(argv[1], "connect") == 0 || strcmp(argv[1], "connect-abstract") == 0 || strcmp(argv[1], "bind") == 0)) {
    int descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
    if (descriptor < 0) return report(-1);
    struct sockaddr_un address;
    socklen_t length = named(&address, argv[2], strcmp(argv[1], "connect-abstract") == 0);
    if (strcmp(argv[1], "bind") == 0) return report(bind(descriptor, (struct sockaddr *)&address, length));
    if (connect(descriptor, (struct sockaddr *)&address, length) != 0) return report(-1);
    return report(exchange(descriptor));
  }
  if (argc == 3 && strcmp(argv[1], "connect-loopback") == 0) {
    int descriptor = socket(AF_INET, SOCK_STREAM, 0);
    if (descriptor < 0) return report(-1);
    struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons((unsigned short)atoi(argv[2]))};
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(descriptor, (struct sockaddr *)&address, sizeof address) != 0) return report(-1);
    return report(exchange(descriptor));
  }
  if (argc == 2 && strcmp(argv[1], "bind-loopback") == 0) {
    int descriptor = socket(AF_INET, SOCK_STREAM, 0);
    if (descriptor < 0) return report(-1);
    struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = 0};
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    return report(bind(descriptor, (struct sockaddr *)&address, sizeof address));
  }
  fputs("usage: socket <kind> | pair <kind> | connect <path> | connect-abstract <name> | bind <path> | connect-loopback <port> | bind-loopback\n", stderr);
  return 2;
}
