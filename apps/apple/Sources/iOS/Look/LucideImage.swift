import UIKit

extension UIImage {
    /// A Lucide icon as a UIImage tinted `color`, `size` points square (for TextKit attachments and CALayers).
    static func lucide(_ name: String, size: CGFloat, color: UIColor) -> UIImage? {
        guard let base = UIImage(named: "lucide-\(name)") else { return nil }
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        return UIGraphicsImageRenderer(size: CGSize(width: size, height: size), format: format).image { _ in
            base.withTintColor(color, renderingMode: .alwaysOriginal).draw(in: CGRect(x: 0, y: 0, width: size, height: size))
        }
    }
}

