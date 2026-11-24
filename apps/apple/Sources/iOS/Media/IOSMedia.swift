import PhotosUI
import QuickLook
import UIKit
import UniformTypeIdentifiers

/// The iPad and iPhone side of images and attachments: the pickers (Photos, Files, the camera), what a paste or a drop
/// carries, and the preview (Quick Look, which also shares).
enum PlatformMedia {
    /// Ask for pictures or files; `done` gets what was chosen (nothing if cancelled) on the main thread.
    static func pick(_ kind: MediaKind, done: @escaping ([PickedFile]) -> Void) {
        MediaPresenter.shared.pick(kind, done)
    }

    /// Show a downloaded file in Quick Look (open in another app and share from there); an address opens in the browser.
    static func open(_ url: URL) {
        if url.isFileURL { MediaPresenter.shared.preview(url) } else { UIApplication.shared.open(url) }
    }

    /// A dropped or pasted item that is a picture or a file (not text).
    static func wants(_ p: NSItemProvider) -> Bool {
        if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) || p.hasItemConformingToTypeIdentifier(UTType.image.identifier) { return true }
        return p.hasItemConformingToTypeIdentifier(UTType.data.identifier) && !p.hasItemConformingToTypeIdentifier(UTType.text.identifier)
    }

    /// Read what dropped or pasted items carry, in order.
    static func load(_ providers: [NSItemProvider], done: @escaping ([PickedFile]) -> Void) {
        var found = [PickedFile?](repeating: nil, count: providers.count)
        let lock = NSLock()
        let group = DispatchGroup()
        for (i, p) in providers.enumerated() {
            let type = p.hasItemConformingToTypeIdentifier(UTType.image.identifier) ? UTType.image.identifier : UTType.data.identifier
            group.enter()
            p.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                defer { group.leave() }
                guard let url, let data = try? Data(contentsOf: url) else { return }
                var name = url.lastPathComponent
                if name.isEmpty { name = p.suggestedName ?? "file" }
                lock.lock()
                found[i] = PickedFile(data: data, filename: name)
                lock.unlock()
            }
        }
        group.notify(queue: .main) { done(found.compactMap { $0 }) }
    }
}

/// Presents the pickers and keeps their delegates alive while they are up.
final class MediaPresenter: NSObject, PHPickerViewControllerDelegate, UIDocumentPickerDelegate, UIImagePickerControllerDelegate,
    UINavigationControllerDelegate, QLPreviewControllerDataSource {
    static let shared = MediaPresenter()
    private var done: (([PickedFile]) -> Void)?
    private var previewURL: URL?

    private var top: UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        var vc = scene?.windows.first { $0.isKeyWindow }?.rootViewController ?? scene?.windows.first?.rootViewController
        while let next = vc?.presentedViewController, !next.isBeingDismissed { vc = next }
        return vc
    }

    func pick(_ kind: MediaKind, _ done: @escaping ([PickedFile]) -> Void) {
        self.done = done
        switch kind {
        case .file:
            documents([.item])
        case .image:
            guard let vc = top else { return }
            let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
            sheet.addAction(UIAlertAction(title: "Photo Library", style: .default) { _ in self.photos() })
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                sheet.addAction(UIAlertAction(title: "Take Photo", style: .default) { _ in self.camera() })
            }
            sheet.addAction(UIAlertAction(title: "Choose from Files", style: .default) { _ in self.documents([.image]) })
            sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in self.finish([]) })
            if let pop = sheet.popoverPresentationController {
                pop.sourceView = vc.view
                pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 1, height: 1)
                pop.permittedArrowDirections = []
            }
            vc.present(sheet, animated: true)
        }
    }

    private func finish(_ items: [PickedFile]) {
        let d = done
        done = nil
        if !items.isEmpty { d?(items) }
    }

    // MARK: Photos (no permission needed: the picker runs out of process)

    private func photos() {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 10
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        top?.present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        let providers = results.map(\.itemProvider)
        PlatformMedia.load(providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }) { [weak self] in self?.finish($0) }
    }

    // MARK: Files

    private func documents(_ types: [UTType]) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        picker.allowsMultipleSelection = true
        picker.delegate = self
        top?.present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        DispatchQueue.global(qos: .userInitiated).async {
            let items = urls.compactMap { url -> PickedFile? in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return PickedFile(data: data, filename: url.lastPathComponent)
            }
            DispatchQueue.main.async { self.finish(items) }
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish([]) }

    // MARK: Camera

    private func camera() {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = self
        top?.present(picker, animated: true)
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        guard let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.85) else {
            finish([])
            return
        }
        finish([PickedFile(data: data, filename: MediaPrep.name(forImageType: "jpg"))])
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        finish([])
    }

    // MARK: Quick Look

    func preview(_ url: URL) {
        previewURL = url
        let q = QLPreviewController()
        q.dataSource = self
        top?.present(q, animated: true)
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { previewURL == nil ? 0 : 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        (previewURL ?? URL(fileURLWithPath: "/")) as NSURL
    }
}
