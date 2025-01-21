<h1 align="center">Tails Noir Preludes - Русификатор</h1>

![Обложка русификатора](https://raw.githubusercontent.com/Dellyare/tails-noir-preludes-rus/refs/heads/main/.github/cover.jpg?raw=true)

<h3 align="center">⚠️ ПЕРЕВОД В ПРОЦЕССЕ ⚠️</h3>

---

## Прогресс перевода

| Перевод |          Статус          |
|---------|:------------------------:|
| Акт 1   | ⚠️ Переведено нейросетью |
| Акт 2   |     ❌ Не переведено      |
| Акт 3   |     ❌ Не переведено      |
| Акт 4   |     ❌ Не переведено      |
| Акт 5   |     ❌ Не переведено      |
| NPC     |     ❌ Не переведено      |
| Лай     |     ❌ Не переведено      |
| Меню    |     ❌ Не переведено      |
| Визуал  |     ❌ Не переведено      |

---

### Для работы необходима оригинальная игра!
Купить её можно в этих магазинах:
- [🛒**Steam**](https://store.steampowered.com/app/2020030/Tails_Noir_Preludes/)
- [🛒**EpicGames**](https://store.epicgames.com/ru/p/tails-noir-4240c4)

---

### Установка
- Скачать из [релизов](https://github.com/Dellyare/tails-noir-preludes-rus/releases) файл `TailsRUS_P.pak`
- В нужном лаунчере перейти к файлам игры
- Переместить `TailsRUS_P.pak` в папку игры по пути `\Tails The Backbone Preludes\BackboneStories\Content\Paks`

---

### Помощь в разработке

Внутри репозитория находятся вне инструменты, которые использовались для перевода

Порядок для редактирования выглядит так:
- Отредактировать нужный `text` в файле `JSON-TailsRUS_P/../TRANSLATE-*.json`
- Изменить в `tools/scripts/index.js` константы `fileName` и `RELATIVE_PATH` для создания пути к нужному файлу
- Запустить `tools/utils/UAssetGUI.exe`, указать ему Mapping.usmap как маппинг и назвать пресет `TailsNoir`
- Выполнить `npm run inject`
- Запустить `tools/utils/Packer/UnrealPak-Without-Compression.bat`, пак файл будет в `build/TailsRUS_P.pak`
