#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <unistd.h>

extern char **environ;
static int refuse(void) {
    static const char message[] = "Local engine launch refused.\n";
    const ssize_t written = write(STDERR_FILENO, message, sizeof(message) - 1);
    (void)written;
    return 126;
}
static int ordinary(const char *file, int self) {
    struct stat st;
    if ((self ? stat(file, &st) : lstat(file, &st)) != 0 || !S_ISREG(st.st_mode)
            || st.st_nlink != 1 || (st.st_mode & (S_ISUID | S_ISGID))
            || !(st.st_mode & 0111)) return 0;
    /* A capability-bearing exec can clear PDEATHSIG. Unsupported or denied
       xattr inspection is not proof of absence, so fail closed. */
    errno = 0;
    if (getxattr(file, "security.capability", NULL, 0) >= 0 || errno != ENODATA) return 0;
    /* No shebang interpreter: the packaged Java must itself be the checked
       ELF image, not unvalidated runtime indirection into another executable. */
    const int fd = open(file, O_RDONLY | O_CLOEXEC | (self ? 0 : O_NOFOLLOW));
    if (fd < 0) return 0;
    unsigned char magic[4]; const ssize_t size = read(fd, magic, sizeof(magic));
    (void)close(fd);
    if (size != 4 || memcmp(magic, "\177ELF", 4)) return 0;
    return 1;
}
static int absolute(const char *value) { return value && value[0] == '/' && value[1] != '\0'; }
int main(int argc, char **argv) {
    if (argc != 16 || !argv[1][0] || argv[1][0] == '0') return refuse();
    for (const char *p = argv[1]; *p; p++) if (*p < '0' || *p > '9') return refuse();
    errno = 0; char *end = NULL; long number = strtol(argv[1], &end, 10);
    if (errno || !end || *end || number <= 1 || number > INT_MAX) return refuse();
    const pid_t expected = (pid_t)number;
    if (getppid() != expected || getuid() != geteuid() || getgid() != getegid()) return refuse();
    if (!absolute(argv[2]) || strcmp(argv[3], "--add-modules") || strcmp(argv[4], "jdk.httpserver")
            || strncmp(argv[5], "-Djava.io.tmpdir=/", 18)
            || strncmp(argv[6], "-Dorg.sqlite.tmpdir=/", 21)
            || strcmp(argv[7], "-cp") || !absolute(argv[8])
            || strcmp(argv[9], "com.peentar.thriftquery.LocalEngineMain")
            || strcmp(argv[10], "--resources") || !absolute(argv[11])
            || strcmp(argv[12], "--data-dir") || !absolute(argv[13])
            || strcmp(argv[14], "--temp-dir") || !absolute(argv[15])) return refuse();
    if (!ordinary("/proc/self/exe", 1) || !ordinary(argv[2], 0)) return refuse();
    /* Never fork: ready PID remains this exact ChildProcess PID after exec.
       NNP is inherited only by this engine, never changes the owning host. */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) != 0) return refuse();
    if (prctl(PR_SET_PDEATHSIG, (long)SIGKILL, 0L, 0L, 0L) != 0) return refuse();
    /* A parent can die before prctl arms: don't adopt getppid() as authority. */
    if (getppid() != expected) return refuse();
    execve(argv[2], &argv[2], environ);
    return refuse();
}
