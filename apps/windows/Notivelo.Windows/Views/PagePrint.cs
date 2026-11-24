using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Printing;
using Notivelo.Windows.Text;
using GP = global::Windows.Graphics.Printing;

namespace Notivelo.Windows.Views;

/// <summary>Print (Ctrl+P, the ribbon's Print button, the page menu): the page as it is laid out is drawn to a bitmap (title, boxes, ink), scaled to the paper's width
/// and cut into sheets, and handed to Windows' print dialog, which also offers Microsoft Print to PDF (Save as PDF). The page keeps its own colours and theme, so a dark
/// page prints on a dark sheet.</summary>
internal static class PagePrint
{
    private static bool _busy;

    public static async Task ShowAsync(ShellHost host, FrameworkElement content, string title, Brush paper)
    {
        if (_busy) return;
        _busy = true;
        GP.PrintManager? pm = null;
        global::Windows.Foundation.TypedEventHandler<GP.PrintManager, GP.PrintTaskRequestedEventArgs>? requested = null;
        try
        {
            if (MainWindow.Instance is not { } win) return;
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(win);
            double cw = content.ActualWidth, ch = content.ActualHeight;
            if (cw <= 0 || ch <= 0) { host.Toast("There is nothing to print yet", true); return; }
            var bitmap = new RenderTargetBitmap();
            await bitmap.RenderAsync(content);

            var doc = new PrintDocument();
            var sheets = new List<UIElement>();
            void Build(double pw, double ph)
            {
                sheets.Clear();
                var (scale, count) = PrintRules.Layout(cw, ch, pw, ph);
                for (var i = 0; i < count; i++)
                {
                    var sheet = new Grid { Width = pw, Height = ph, Background = paper, Clip = new RectangleGeometry { Rect = new global::Windows.Foundation.Rect(0, 0, pw, ph) } };
                    sheet.Children.Add(new Image
                    {
                        Source = bitmap, Stretch = Stretch.Fill, Width = cw * scale, Height = ch * scale,
                        HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, -i * ph, 0, 0),
                    });
                    sheets.Add(sheet);
                }
            }
            doc.Paginate += (_, e) =>
            {
                var d = e.PrintTaskOptions.GetPageDescription(0);
                Build(d.ImageableRect.Width, d.ImageableRect.Height);
                doc.SetPreviewPageCount(sheets.Count, PreviewPageCountType.Final);
            };
            doc.GetPreviewPage += (_, e) => doc.SetPreviewPage(e.PageNumber, sheets[Math.Clamp(e.PageNumber - 1, 0, sheets.Count - 1)]);
            doc.AddPages += (_, _) => { foreach (var s in sheets) doc.AddPage(s); doc.AddPagesComplete(); };

            pm = GP.PrintManagerInterop.GetForWindow(hwnd);
            var job = PrintRules.JobName(title);
            requested = (_, a) => a.Request.CreatePrintTask(job, r => r.SetSource(doc.DocumentSource));
            pm.PrintTaskRequested += requested;
            await GP.PrintManagerInterop.ShowPrintUIForWindowAsync(hwnd);
        }
        catch (Exception e) { host.Toast("Couldn't open printing. " + e.Message, true); }
        finally
        {
            if (pm is not null && requested is not null) pm.PrintTaskRequested -= requested;
            _busy = false;
        }
    }
}
