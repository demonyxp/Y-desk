using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
using System.Web.Script.Serialization;

internal static class Program
{
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
    [StructLayout(LayoutKind.Explicit)] struct UNION
    {
        [FieldOffset(0)] public MOUSEINPUT mouse;
        [FieldOffset(0)] public KEYBDINPUT key;
    }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT
    {
        public int dx, dy;
        public uint mouseData, flags, time;
        public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT
    {
        public ushort vk, scan;
        public uint flags, time;
        public UIntPtr extra;
    }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    static readonly object Gate = new object();
    static readonly Dictionary<ushort, bool> Keys = new Dictionary<ushort, bool>();
    static readonly HashSet<int> Buttons = new HashSet<int>();
    static long lastInput = Environment.TickCount;
    static bool dryRun;

    static void Emit(INPUT input)
    {
        if (dryRun)
        {
            if (input.type == 1) Console.WriteLine("{\"native\":true,\"type\":\"key\",\"vk\":" + input.data.key.vk + ",\"scan\":" + input.data.key.scan + ",\"flags\":" + input.data.key.flags + "}");
            else Console.WriteLine("{\"native\":true,\"type\":\"mouse\",\"x\":" + input.data.mouse.dx + ",\"y\":" + input.data.mouse.dy + ",\"flags\":" + input.data.mouse.flags + "}");
            return;
        }
        if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
            Console.Error.WriteLine("输入被系统阻止，可能是 UAC 或权限等级不同。");
    }
    static void Mouse(uint flags, int x, int y, uint data)
    {
        INPUT input = new INPUT();
        input.type = 0;
        input.data.mouse = new MOUSEINPUT { flags = flags, dx = x, dy = y, mouseData = data };
        Emit(input);
    }
    static void Key(ushort vk, bool down, bool extended)
    {
        INPUT input = new INPUT();
        input.type = 1;
        input.data.key = new KEYBDINPUT { vk = vk, flags = (down ? 0u : 2u) | (extended ? 1u : 0u) };
        Emit(input);
        if (down) Keys[vk] = extended; else Keys.Remove(vk);
    }
    static void Button(int button, bool down)
    {
        uint[] flags = { 2, 32, 8 };
        Mouse(down ? flags[button] : flags[button] * 2, 0, 0, 0);
        if (down) Buttons.Add(button); else Buttons.Remove(button);
    }
    static void Release()
    {
        foreach (KeyValuePair<ushort, bool> key in new Dictionary<ushort, bool>(Keys)) Key(key.Key, false, key.Value);
        foreach (int button in new List<int>(Buttons)) Button(button, false);
    }
    static int Number(Dictionary<string, object> message, string name) { return Convert.ToInt32(message[name]); }
    static void Handle(Dictionary<string, object> message)
    {
        string type = Convert.ToString(message["type"]);
        lastInput = Environment.TickCount;
        if (type == "release") { Release(); return; }
        if (type == "heartbeat") return;
        if (type == "key")
        {
            int vk = Number(message, "vk");
            if (vk < 1 || vk > 254) return;
            Key((ushort)vk, (bool)message["down"], (bool)message["extended"]);
            return;
        }
        if (type == "text")
        {
            string text = Convert.ToString(message["text"]);
            if (text.Length > 2000) return;
            Release();
            foreach (char character in text)
            {
                INPUT input = new INPUT();
                input.type = 1;
                input.data.key = new KEYBDINPUT { scan = character, flags = 4 };
                Emit(input);
                input.data.key.flags = 6;
                Emit(input);
            }
            return;
        }
        if (type != "move" && type != "button" && type != "wheel") return;
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
        int width = Math.Max(2, GetSystemMetrics(78)), height = Math.Max(2, GetSystemMetrics(79));
        // 按整个虚拟桌面归一化，兼容左侧负坐标屏幕与不同 DPI。
        int x = Math.Max(0, Math.Min(width - 1, Number(message, "x") - left));
        int y = Math.Max(0, Math.Min(height - 1, Number(message, "y") - top));
        Mouse(0x8000 | 0x4000 | 1, (int)((long)x * 65535 / (width - 1)), (int)((long)y * 65535 / (height - 1)), 0);
        if (type == "button")
        {
            int button = Number(message, "button");
            if (button >= 0 && button <= 2) Button(button, (bool)message["down"]);
        }
        if (type == "wheel") Mouse(0x0800, 0, 0, unchecked((uint)Math.Max(-1200, Math.Min(1200, Number(message, "delta")))));
    }
    static void Main(string[] args)
    {
        // 与 Node 管道统一使用 UTF-8，避免中文被系统代码页误解码。
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        dryRun = Array.IndexOf(args, "--dry-run") >= 0;
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
        JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 16384 };
        // 即使主进程异常退出或数据通道失联，也不能留下按住的按键。
        using (Timer watchdog = new Timer(delegate {
            lock (Gate) { if (unchecked((uint)(Environment.TickCount - lastInput)) > 3000) Release(); }
        }, null, 1000, 1000))
        {
            Console.WriteLine("ready");
            string line;
            try
            {
                while ((line = Console.ReadLine()) != null)
                {
                    if (line.Length > 16384) continue;
                    try
                    {
                        lock (Gate) Handle(serializer.Deserialize<Dictionary<string, object>>(line));
                        if (dryRun) Console.WriteLine(line);
                    }
                    catch (Exception) { Console.Error.WriteLine("忽略无效输入事件。"); }
                }
            }
            finally { lock (Gate) Release(); }
        }
    }
}
