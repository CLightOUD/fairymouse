using System;
using System.Runtime.InteropServices;
public class TrialNative {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
 public static object Read() { Point p; bool ok=GetCursorPos(out p); return new { utc=DateTime.UtcNow.ToString("o"), foreground=GetForegroundWindow().ToInt64(), x=p.X, y=p.Y, cursorReadable=ok }; }
}
