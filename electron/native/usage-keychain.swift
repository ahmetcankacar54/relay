import Foundation
import Security
import LocalAuthentication
// A read-only, profile-scoped bridge. Secrets go only to the parent process's pipe.
let input = FileHandle.standardInput.readDataToEndOfFile()
guard let service = String(data: input, encoding: .utf8),
      service.range(of: "^Claude Code-credentials-[0-9a-f]{8}$", options: .regularExpression) != nil else { exit(2) }
let allowPrompt = CommandLine.arguments.dropFirst().elementsEqual(["--allow-prompt"])
// The LocalAuthentication setting protects modern access-control items. The
// process-wide legacy Keychain switch also forbids password/ACL dialogs.
guard SecKeychainSetUserInteractionAllowed(allowPrompt) == errSecSuccess else { exit(3) }
let authentication = LAContext()
authentication.interactionNotAllowed = !allowPrompt
var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne,
    kSecUseAuthenticationContext as String: authentication
]
if !allowPrompt {
    query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
}
var result: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &result)
if status == errSecItemNotFound { exit(4) }
guard status == errSecSuccess, let data = result as? Data, data.count <= 65536 else { exit(3) }
FileHandle.standardOutput.write(data)
