# Envía bytes ESC/POS "en crudo" (RAW) a una impresora instalada en Windows (USB).
# Lo usa agente-impresion.js cuando la impresora está conectada por USB a esta computadora.
#   powershell -NoProfile -ExecutionPolicy Bypass -File imprimir-raw.ps1 -Printer "POS-80" -File comanda.bin
#   powershell -NoProfile -ExecutionPolicy Bypass -File imprimir-raw.ps1 -Listar
param(
  [string]$Printer,
  [string]$File,
  [switch]$Listar
)
$ErrorActionPreference = 'Stop'

if ($Listar) {
  Get-CimInstance Win32_Printer | Select-Object Name, PortName, WorkOffline | Format-Table -AutoSize | Out-String -Width 200
  exit 0
}

$code = @"
using System;
using System.Runtime.InteropServices;
public class BirriazaRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern int StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr h, byte[] data, int count, out int written);

  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("No se encontro la impresora '" + printer + "' en Windows (error " + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = "Comanda La Birriaza";
      di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("Windows no acepto el trabajo (error " + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, data, data.Length, out written) || written != data.Length)
          throw new Exception("No se pudo enviar la comanda (error " + Marshal.GetLastWin32Error() + ")");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@

try {
  if (-not $Printer -or -not $File) { throw 'Faltan -Printer y -File' }
  if (-not ('BirriazaRawPrint' -as [type])) { Add-Type -TypeDefinition $code }
  [BirriazaRawPrint]::Send($Printer, [System.IO.File]::ReadAllBytes($File))
  # Si Windows marca la impresora como desconectada, avisamos (el trabajo queda en cola)
  $p = Get-CimInstance Win32_Printer -Filter ("Name='" + $Printer.Replace("'", "''") + "'") -ErrorAction SilentlyContinue
  if ($p -and $p.WorkOffline) { [Console]::Error.WriteLine('AVISO: Windows reporta la impresora como desconectada; revisa el cable USB y que este encendida.') }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
