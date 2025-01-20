<h3 align="center">Tails Noir Preludes - Русификатор</h3>

---

#### Для работы необходима оригинальная игра!
Купить её можно в этих магазинах:
- [🛒**Steam**](https://store.steampowered.com/app/2020030/Tails_Noir_Preludes/)
- [🛒**EpicGames**](https://store.epicgames.com/ru/p/tails-noir-4240c4)

---

### Установка
- Скачайте из релизов файл `TailsRUS_P.pak`
- В нужном лаунчере перейдите к файлам игры
- Переместите `TailsRUS_P.pak` в папку игры по пути `\Tails The Backbone Preludes\BackboneStories\Content\Paks`

Готово!

---

Внутри репозитория находятся вне инструменты, которые использовались для перевода

Порядок для редактирования выглядит так:
- Редактируем необходимый текст в `JSON-TailsRUS_P/../TRANSLATE-*.json`
- Запускаем скрипт `tools/scripts/index.js` в режиме `inject`
- Открываем `JSON-TailsRUS_P/../*.json` в `tools/utils/UAssetGUI.exe`
- Выбираем **Save as** и перезаписываем нужный файл в `TailsRUS_P/../../*.uasset`
- Перетаскиваем всю папку `TailsRUS_P` на `tools/utils/Packer/UnrealPak-Without-Compression.bat` файл
