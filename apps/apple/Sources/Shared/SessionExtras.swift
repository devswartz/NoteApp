import Foundation
import NotiveloCore

// Tree writes, sharing and locked pages: the core's calls of 2026-11-22 (docs/rewrite/status/core.md, "For apple: …").

extension SessionModel {
    /// A message for the person: the server's own words when it gave some, else the usual one-liner.
    static func plainMessage(_ error: Error) -> String {
        if case let .Server(_, message, _)? = error as? CoreError, !message.isEmpty { return message }
        return CoreBridge.message(error)
    }

    /// A tree write: `work` runs on the core queue. After every write the core fetches the workspace's tree again and
    /// stores it, so the stored tree is taken as the new one (without a store it is fetched here).
    func changeTree<T>(_ work: @escaping (Core, String) throws -> T, then done: @escaping (Result<T, Error>) -> Void) {
        guard let ws = workspaceId else {
            done(.failure(CancellationError()))
            return
        }
        call({ core -> (T, Tree?) in
            let value = try work(core, ws)
            return (value, core.cachedTree(workspaceId: ws) ?? (try? core.tree(workspaceId: ws)))
        }) { result in
            switch result {
            case let .success((value, tree)):
                if ws == self.workspaceId, let tree { self.tree = tree }
                done(.success(value))
            case let .failure(e):
                done(.failure(e))
            }
        }
    }

    // MARK: Shared with me

    func loadShared() {
        guard !preview else { return }
        call({ try $0.sharedPages() }) { result in
            if case let .success(list) = result { self.sharedPages = list }
        }
    }

    /// "Remove from Shared with me": your own share of the page ends.
    func leaveShare(pageId: String, done: @escaping (String?) -> Void) {
        guard let me = user?.id else { return done(nil) }
        call({ try $0.removePageShare(pageId: pageId, userId: me) }) { result in
            switch result {
            case .success:
                self.sharedPages.removeAll { $0.id == pageId }
                done(nil)
            case let .failure(e):
                done(e is CancellationError ? nil : SessionModel.plainMessage(e))
            }
        }
    }

    // MARK: Locked pages

    func loadLockStatus() {
        guard !preview else { return }
        call({ try $0.lockedNotesStatus() }) { result in
            if case let .success(s) = result {
                self.lockStatus = s
                self.locksOpen = s.unlocked
            }
        }
    }

    private func didUnlock() {
        locksOpen = true
        loadLockStatus()
        refreshTasks()
    }

    /// Unlock the locked pages with the password; `done` gets nil, or what went wrong.
    func unlock(password: String, done: @escaping (String?) -> Void) {
        call({ try $0.unlockLockedNotes(password: password) }) { result in
            switch result {
            case .success:
                self.didUnlock()
                self.registerDevice()
                done(nil)
            case let .failure(e):
                if !(e is CancellationError) { done(SessionModel.plainMessage(e)) }
                self.loadLockStatus()
            }
        }
    }

    /// Unlock with Face ID: the device secret in the keychain, behind the biometric check.
    func unlockWithDevice(done: @escaping (String?) -> Void) {
        let account = serverURL
        DeviceUnlock.read(account: account) { credential in
            guard let credential else { return done(nil) }
            let install = DeviceUnlock.installId
            self.call({ try $0.unlockLockedNotesWithDevice(deviceId: credential.id, secret: credential.secret, installId: install) }) { result in
                switch result {
                case .success:
                    self.didUnlock()
                    done(nil)
                case let .failure(e):
                    if e is CancellationError { return }
                    if case let .Server(status, _, _)? = e as? CoreError, status == 401 {
                        DeviceUnlock.forget(account: account)
                        done("Face ID doesn’t work for this sign-in any more. Enter your password.")
                    } else {
                        done(SessionModel.plainMessage(e))
                    }
                    self.loadLockStatus()
                }
            }
        }
    }

    /// After a password unlock: a device secret for Face ID, kept in the keychain behind the biometric check.
    private func registerDevice() {
        guard DeviceUnlock.available else { return }
        let account = serverURL
        let install = DeviceUnlock.installId
        call({ try $0.registerUnlockDevice(installId: install, label: "Notivelo app") }) { result in
            if case let .success(device) = result { DeviceUnlock.store(id: device.id, secret: device.secret, account: account) }
        }
    }

    /// "Lock now" (also when the app goes to the background): shown locked at once, then told to the server.
    func lockNow() {
        guard locksOpen else { return }
        locksOpen = false
        call({ try $0.lockLockedNotes() }) { _ in
            self.loadLockStatus()
            self.refreshTasks()
        }
    }

    /// While a locked page is on screen: asked about once a minute.
    func keepLocksAlive() {
        guard locksOpen else { return }
        call({ try $0.keepLockedNotesUnlocked() }) { result in
            if case let .success(k) = result, !k.unlocked { self.locksOpen = false }
        }
    }

    func setLockPassword(_ password: String, current: String?, done: @escaping (String?) -> Void) {
        call({ try $0.setLockedNotesPassword(password: password, currentPassword: current) }) { result in
            switch result {
            case .success:
                self.didUnlock()
                self.registerDevice()
                done(nil)
            case let .failure(e):
                if !(e is CancellationError) { done(SessionModel.plainMessage(e)) }
            }
        }
    }

    func lock(page id: String, done: @escaping (String?) -> Void) {
        changeTree({ core, _ in try core.lockPage(pageId: id) }) { result in
            switch result {
            case .success:
                self.refreshTasks()
                done(nil)
            case let .failure(e):
                if !(e is CancellationError) { done(SessionModel.plainMessage(e)) }
            }
        }
    }

    func removeLock(page id: String, password: String, done: @escaping (String?) -> Void) {
        changeTree({ core, _ in try core.removePageLock(pageId: id, password: password) }) { result in
            switch result {
            case .success:
                self.refreshTasks()
                done(nil)
            case let .failure(e):
                if !(e is CancellationError) { done(SessionModel.plainMessage(e)) }
            }
        }
    }
}
