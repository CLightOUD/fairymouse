using System;
using System.IO;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class DesktopTrial : Form {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    string dir;
    TextBox input;
    Label result;
    CheckBox check;
    ComboBox choice;
    ListBox list;
    Timer timer;
    StreamWriter log;
    DateTime started = DateTime.UtcNow;
    bool initialized=false;
    int activations=0;
    protected override bool ShowWithoutActivation { get { return true; } }
    public DesktopTrial(string d) {
        dir=d; Text="Fairy Agent Desktop Trial"; Name="FairyDesktopTrial";
        StartPosition=FormStartPosition.Manual; Location=new Point(100,100); ClientSize=new Size(420,350);
        input=new TextBox { Name="TrialInput", AccessibleName="TrialInput", Location=new Point(20,25), Width=370, Text="before" };
        var button=new Button { Name="TrialApply", AccessibleName="TrialApply", Text="Apply test value", Location=new Point(20,75), Width=160 };
        var pause=new Button { Name="TrialPause", Text="Pause UI", Location=new Point(20,180), Width=120 };
        pause.Click += delegate { File.WriteAllText(Path.Combine(dir,"paused.flag"),"yes"); System.Threading.Thread.Sleep(1500); };
        check=new CheckBox { Name="TrialCheck", AccessibleName="TrialCheck", Text="Background test checkbox", Location=new Point(200,80), Width=200, FlatStyle=FlatStyle.System };
        result=new Label { Name="TrialResult", Text="Not applied", Location=new Point(20,130), Width=380, Height=60 };
        choice=new ComboBox { Name="TrialChoice", AccessibleName="TrialChoice", Location=new Point(170,180), Width=220, DropDownStyle=ComboBoxStyle.DropDownList };
        choice.Items.AddRange(new object[]{"Alpha","Beta","Gamma"}); choice.SelectedIndex=0;
        list=new ListBox { Name="TrialList", AccessibleName="TrialList", Location=new Point(20,220), Width=370, Height=110 };
        for(int n=0;n<30;n++) list.Items.Add("Item "+n); list.SelectedIndex=0;
        Controls.AddRange(new Control[]{input,button,check,result,pause,choice,list});
        button.Click += delegate { result.Text="Applied: " + input.Text; WriteState("button"); };
        input.TextChanged += delegate { WriteState("text"); };
        check.CheckedChanged += delegate { WriteState("check"); };
        choice.SelectedIndexChanged += delegate { WriteState("choice"); };
        list.SelectedIndexChanged += delegate { WriteState("list"); };
        log=new StreamWriter(Path.Combine(dir,"telemetry.tsv"),false); log.AutoFlush=true;
        log.WriteLine("utc\tforeground\tx\ty");
        timer=new Timer { Interval=15 };
        timer.Tick += delegate {
            if(!initialized) {
                ShowWindow(Handle,4);
                SetWindowPos(Handle,new IntPtr(1),0,0,0,0,0x0013);
                initialized=true;
                WriteState("ready");
            }
            Point p; GetCursorPos(out p);
            log.WriteLine(DateTime.UtcNow.ToString("o")+"\t"+GetForegroundWindow().ToInt64()+"\t"+p.X+"\t"+p.Y);
            if(File.Exists(Path.Combine(dir,"close.flag")) || (DateTime.UtcNow-started).TotalMinutes>12) Close();
        };
        Shown += delegate { SetWindowPos(Handle,new IntPtr(1),0,0,0,0,0x0013); WriteState("shown"); timer.Start(); };
        Activated += delegate { activations++; File.AppendAllText(Path.Combine(dir,"activations.txt"), DateTime.UtcNow.ToString("o")+"\r\n"); };
        FormClosed += delegate { timer.Stop(); log.Dispose(); };
    }
    void WriteState(string action) {
        File.WriteAllText(Path.Combine(dir,"fixture-state.txt"), "action="+action+"\r\ninput="+input.Text+"\r\nchecked="+check.Checked+"\r\nresult="+result.Text+"\r\nchoice="+choice.SelectedIndex+"\r\nlist="+list.SelectedIndex+"\r\nhandle="+Handle.ToInt64()+"\r\nactivations="+activations, new System.Text.UTF8Encoding(false, false));
    }
    [STAThread] public static void Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new DesktopTrial(args[0]));
    }
}
