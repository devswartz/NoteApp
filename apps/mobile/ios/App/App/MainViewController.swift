import UIKit
import Capacitor

/// The app's web view controller; registers the app's own plugin.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NoteAppNativePlugin())
    }
}
