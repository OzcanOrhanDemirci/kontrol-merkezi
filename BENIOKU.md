# Kontrol Merkezi

Bu bilgisayarın fanlarını ve RGB ışıklarını tek pencereden yöneten masaüstü uygulaması. Fan Anahtarı'nın ve
üreticilerin RGB programlarının yerine geçer. İki sekme var, başka sayfa yok:

- **Fanlar:** bir düğme işlemci ve kasa fanlarını en yükseğe alır, tekrar basınca BIOS ayarına döndürür (Fan
  Anahtarı'nın çip kodu aynen). İkinci düğme ekran kartı fanlarını en yükseğe alır, tekrar basınca kartın kendi
  otomatiğine döndürür. Afterburner'ın fan denetimi açıksa küçük bir uyarı çıkar, çünkü düğmeyle çakışır.
- **RGB:** bütün ışıklar birlikte açılır ya da kapanır. Açıkken renk bilgisayarın sıcaklığını izler (işlemci ve
  ekran kartı sıcaklığının düz ortalaması, yaklaşık 30 saniyeye yayılmış, ani dalgalanmaları izlemez): soğuk beyaz, serin açık mavi, ılık koyu mavi,
  sıcak sarı, çok sıcak turuncu, en sıcakta kırmızı; geçişler yumuşak. Işık her zaman tam parlaklıkta.
  - Renk yalnız sıcaklıktan gelir. Yerel yapay zekâ modeli yanıt yazarken ve işlemci uzun süre (30 sn) yoğun
    yükteyken renk değişmez; ışığın üstünde sakin birer efekt oynar (parlaklık ve hareket). Hangi efektin
    oynayacağı `ayarlar.json`'da `efektler` altında seçilir (iki aday var).
  - Jarvis düşünürken her halkada yumuşak bir parıltı döner; senden yanıt beklerken bütün ışıklar yavaşça nefes
    alır; kapalıyken pompa halkası sönük bir kor gibi durur; yeniden açılırken pompa halkasında beyaz bir nokta döner;
    geri gelince bir kez parlar.
- Pencerenin ışığı kasanın ışığıdır: ekrandaki sahne o an kasanın gösterdiği renkle aydınlanır.

Klavye ve fare 15 dakika kullanılmazsa ışıklar yumuşakça söner (arkada çalışan işler sayılmaz); ilk dokunuşta geri
yanar. Bilgisayar her açıldığında ışıklar kapalı başlar. Pencere kapalıyken ekran kartına hiç iş yüklemez.

## Kurulum (bir kez)

`C:\dev\kontrol-merkezi\Kurulum.cmd`'ye çift tıkla, Windows'un sorusuna "Evet" de. Komut yazmak ya da derlemek
gerekmez: hazır derlenmiş program kurulur.

Kurulum programı `C:\Program Files\KontrolMerkezi`'ye kopyalar, oturum açılışında servisi UAC sormadan yönetici
olarak başlatan `KontrolMerkezi` görevini kaydeder, masaüstüne ve Başlat menüsüne "Kontrol Merkezi" kısayolunu koyar,
servisi başlatır ve salt okuma bir döküm alır (sonuç `kur-gunluk.txt`). Fan Anahtarı'na ve PawnIO'ya dokunmaz;
Fan Anahtarı sen yenisini kabul edene kadar kurulu kalır. Güncellemek için aynı dosya; kaldırmak için yönetici
PowerShell'de `kur.ps1 -Kaldir`.

## Nasıl çalışır

- `KontrolMerkezi.exe servis`: arka plandaki servis. Bütün cihazlar onda: fan çipi (PawnIO), işlemci sıcaklığı,
  ekran kartı sıcaklığı ve fanları (NVIDIA sürücüsü), RGB cihazları (USB). Saniyede 30 kez ışığı hesaplar.
- `KontrolMerkezi.exe` (kısayol): pencere. Hiçbir cihaza dokunmaz; servisle bir boru üzerinden konuşur.
- Uyku: uykuya geçerken ışıklar kararır; uyanınca ışıklar yeniden açılır ve en yükseğe alınmış fanlar donanım
  unuttuysa yeniden en yükseğe alınır.
- Ayrıntılar: `docs/PROTOKOL.md` (süreçler ve mesajlar), `docs/RGB_SURUCULER.md` (sürücüler, neyin kalıcı yazdığı),
  `docs/GPU_ISIK_PLANI.md` (ekran kartı ışığının kanıt planı).

## Güvenlik

- Fan çipine yalnız Fan Anahtarı'nın 09-30'da ölçülen dizisi yazılır: MAX'tan önce çipten okunan değerler kaydedilir,
  dönüşte aynen geri yazılır ve okunarak doğrulanır. Kayıt yoksa fanlar en yüksekte kalır; yeniden başlatmak her
  durumda BIOS ayarına döndürür.
- Ekran kartı fanları sürücünün ayarıdır, yeniden başlatınca silinir. Servis kapanırken ya da çökerken kartın kendi
  otomatiğine döndürür.
- RGB: yalnız cihazların geçici (canlı) renk yolu kullanılır. Cihazın belleğine kaydeden komutlar hiç gönderilmez, o
  yüzden açılıştaki "kapalı" hâlleri değişmez.
- Ekran kartının ışığına bu gece hiç dokunulmadı (okuma bile yok). Sürücüsü kilitli; kanıt adımı birlikte yapılacak.

## Dosyalar

`%LOCALAPPDATA%\KontrolMerkezi\`: `gunluk.txt` (ne olduysa), `isi-gecmisi.csv` (dakikada bir sıcaklık; renk
duraklarını gerçek günlere göre ayarlamak için), `ayarlar.json` (renk durakları, iki özel durumun rengi, cihaz başına
renk eşleme çarpanları; servis yeniden başlayınca geçerli), `okuma.txt` (`KontrolMerkezi.exe oku` dökümü).

Pencerede ara ara kısa donma görülürse: `araclar\donma-testi.ps1` ölçer; RTSS (RivaTuner) penceredeki kancası
yüzünden olduğu anlaşılırsa `araclar\rtss-istisna.cmd` RTSS'e yalnız bu pencere için "kanca yok" profili ekler
(`rtss-istisna.cmd geri` kaldırır).

Işık denemeleri: `KontrolMerkezi.exe rgb-dene aio renk FF0000 5`, `rgb-dene aio dalga 30` (LED sırasını gösterir),
`rgb-dene klavye dalga 15`, `rgb-dene aio sondur`.
