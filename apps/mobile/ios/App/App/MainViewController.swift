import UIKit
import Capacitor
import NvInk

/// The app's web view controller; registers the app's own plugin.
class MainViewController: CAPBridgeViewController {
    /// While the ink pen layer is on a page, the system's three-finger editing gestures are off:
    /// there a three-finger tap is redo and a two-finger tap undo, as in Notability.
    override var editingInteractionConfiguration: UIEditingInteractionConfiguration {
        NativeInkController.attachedCount > 0 ? .none : .default
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NoteAppNativePlugin())
        bridge?.registerPluginInstance(NoteAppInkPlugin())
    }
}
