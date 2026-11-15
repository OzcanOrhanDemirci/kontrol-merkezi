// Small JSON helpers: a streaming writer for the hot path (30 Hz light frames) and a parser for commands and files.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Web.Script.Serialization;

namespace KontrolMerkezi;

sealed class Json
{
    readonly StringBuilder _sb = new(256);
    readonly Stack<char> _open = new();
    bool _comma;

    void Name(string k) { if (_comma) _sb.Append(','); _comma = false; if (k != null) Q(_sb, k).Append(':'); }

    public Json Obj(string k = null) { Name(k); _sb.Append('{'); _open.Push('}'); return this; }
    public Json Arr(string k = null) { Name(k); _sb.Append('['); _open.Push(']'); return this; }
    public Json End() { _sb.Append(_open.Pop()); _comma = true; return this; }
    public Json Str(string k, string v) { Name(k); if (v == null) _sb.Append("null"); else Q(_sb, v); _comma = true; return this; }
    public Json Num(string k, double v) { Name(k); _sb.Append(double.IsNaN(v) || double.IsInfinity(v) ? "null" : v.ToString("0.###", CultureInfo.InvariantCulture)); _comma = true; return this; }
    public Json Num(string k, double? v) => v.HasValue ? Num(k, v.Value) : Null(k);
    public Json Int(string k, long v) { Name(k); _sb.Append(v.ToString(CultureInfo.InvariantCulture)); _comma = true; return this; }
    public Json Bool(string k, bool v) { Name(k); _sb.Append(v ? "true" : "false"); _comma = true; return this; }
    public Json Null(string k) { Name(k); _sb.Append("null"); _comma = true; return this; }
    public Json Rgb(string k, int r, int g, int b)
    {
        Name(k);
        _sb.Append('[').Append(r).Append(',').Append(g).Append(',').Append(b).Append(']');
        _comma = true;
        return this;
    }
    public override string ToString() => _sb.ToString();

    static StringBuilder Q(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (var c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.Append('"');
    }

    /// <summary>Parse an object; null if the text is not a JSON object.</summary>
    public static Dictionary<string, object> Parse(string text)
    {
        try { return new JavaScriptSerializer().DeserializeObject(text) as Dictionary<string, object>; }
        catch { return null; }
    }

    public static string S(Dictionary<string, object> d, string k) => d != null && d.TryGetValue(k, out var v) ? v as string : null;
    public static bool? B(Dictionary<string, object> d, string k) => d != null && d.TryGetValue(k, out var v) && v is bool b ? b : null;

    /// <summary>Indent compact JSON for files a person may open.</summary>
    public static string Pretty(string json)
    {
        var sb = new StringBuilder();
        int depth = 0;
        bool str = false, esc = false;
        foreach (var c in json)
        {
            if (str)
            {
                sb.Append(c);
                if (esc) esc = false;
                else if (c == '\\') esc = true;
                else if (c == '"') str = false;
                continue;
            }
            switch (c)
            {
                case '"': str = true; sb.Append(c); break;
                case '{': case '[': sb.Append(c).Append("\r\n").Append(' ', ++depth * 2); break;
                case '}': case ']': sb.Append("\r\n").Append(' ', --depth * 2).Append(c); break;
                case ',': sb.Append(c).Append("\r\n").Append(' ', depth * 2); break;
                case ':': sb.Append(": "); break;
                default: sb.Append(c); break;
            }
        }
        return sb.ToString();
    }
}
