export const HOST_SECRET_STORE =
  process.platform === 'darwin'
    ? { program: 'security', backend: 'keychain', refusal: /security \(Keychain\) is not on PATH/, env: {} as Record<string, string>, declaresBus: false }
    : {
        program: 'secret-tool',
        backend: 'secret-service',
        refusal: /secret-tool \(Secret Service\) is not on PATH/,
        env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/momonga-test-bus' },
        declaresBus: true,
      };
