// Код целиком написан нейросетью claude-3.5-sonnet
// Спасибо, что работает

const fileName = '2-1Carlo';

// Базовые пути к папкам
const UASSET_ROOT = '../../TailsRUS_P';
const JSON_ROOT = '../../Json-TailsRUS_P';

// Относительный путь к файлу (одинаковый для обоих корневых каталогов)
const RELATIVE_PATH = 'BackboneStories/Content/Data/Dialogues/Act_II';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// Функция для получения абсолютных путей к файлам
function getFilePaths(relativePath, filename) {
    return {
        uasset: path.resolve(process.cwd(), UASSET_ROOT, relativePath, `${filename}.uasset`),
        json: path.resolve(process.cwd(), JSON_ROOT, relativePath, `${filename}.json`),
        translateJson: path.resolve(process.cwd(), JSON_ROOT, relativePath, `TRANSLATE-${filename}.json`)
    };
}

// Функция для создания директории рекурсивно
function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// Функция для чтения и парсинга JSON файла
function readJsonFile(filePath) {
    try {
        const rawData = fs.readFileSync(filePath);
        const jsonData = JSON.parse(rawData);
        return jsonData;
    } catch (error) {
        console.error('Ошибка при чтении или парсинге JSON файла:', error);
        return null;
    }
}

// Рекурсивная функция для поиска всех TextPropertyData
function findAllTextProperties(obj, path = []) {
    let results = [];

    if (Array.isArray(obj)) {
        obj.forEach((item, index) => {
            results = results.concat(findAllTextProperties(item, [...path, index]));
        });
    } else if (obj && typeof obj === 'object') {
        if (obj['$type'] === 'UAssetAPI.PropertyTypes.Objects.TextPropertyData, UAssetAPI') {
            // Добавляем только если есть и путь, и ключ
            if (obj.Value !== null && path.length > 0) {
                results.push({
                    path: path.join('.'),
                    value: obj.Value,
                    text: obj.CultureInvariantString || ''
                });
            }
        }

        Object.entries(obj).forEach(([key, value]) => {
            results = results.concat(findAllTextProperties(value, [...path, key]));
        });
    }

    return results;
}

// Получаем аргумент из командной строки: 'extract' или 'inject'
const mode = process.argv[2] || 'extract';

// Добавляем новую функцию для работы с UAssetGUI
function executeUAssetGUI(args) {
    return new Promise((resolve, reject) => {
        const uassetGuiPath = path.resolve(process.cwd(), '../utils/UAssetGUI');

        execFile(uassetGuiPath, [...args, 'TailsNoir'], (error, stdout, stderr) => {
            if (error) {
                console.error('Ошибка при выполнении UAssetGUI:', error);
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

// Функция для конвертации uasset в json
async function convertUassetToJson(uassetFile, jsonFile) {
    try {
        await executeUAssetGUI([
            'tojson',
            uassetFile,
            jsonFile,
            'VER_UE5_1',
        ]);
        console.log('Успешно сконвертировано в JSON');
        return true;
    } catch (error) {
        console.error('Ошибка при конвертации в JSON:', error);
        return false;
    }
}

// Функция для конвертации json обратно в uasset
async function convertJsonToUasset(jsonFile, uassetFile) {
    try {
        await executeUAssetGUI([
            'fromjson',
            jsonFile,
            uassetFile,
        ]);
        console.log('Успешно сконвертировано в UASSET');
        return true;
    } catch (error) {
        console.error('Ошибка при конвертации в UASSET:', error);
        return false;
    }
}

// Получаем пути к файлам
const paths = getFilePaths(RELATIVE_PATH, fileName);

// Модифицируем основную логику
async function main() {
    if (mode === 'extract') {
        // Создаем директорию для JSON если её нет
        ensureDirectoryExists(path.dirname(paths.json));

        // Конвертируем uasset в json
        const success = await convertUassetToJson(paths.uasset, paths.json);
        if (!success) process.exit(1);

        const input = readJsonFile(paths.json);
        if (!input) process.exit(1);

        const allTexts = findAllTextProperties(input)
            .filter(item => item.value !== null && item.path !== null);

        const translations = allTexts.map(item => ({
            path: item.path,
            key: item.value,
            text: item.text,
            originalText: item.text,
        }));

        try {
            fs.writeFileSync(paths.translateJson, JSON.stringify(translations, null, 2), 'utf8');
            console.log(`Найдено и сохранено ${translations.length} текстов`);
        } catch (error) {
            console.error('Ошибка при сохранении файла:', error);
        }
    } else if (mode === 'inject') {
        const originalFile = readJsonFile(paths.json);
        const translations = readJsonFile(paths.translateJson);

        if (!originalFile || !translations) {
            console.error('Не удалось прочитать файлы');
            process.exit(1);
        }

        // Создаем карту переводов с путями
        const translationsMap = new Map(
            translations.map(item => [item.key, { text: item.text, path: item.path }])
        );

        let updatedCount = 0;

        // Функция для обновления значения по пути
        function updateValueByPath(obj, path, newValue) {
            const parts = path.split('.');
            let current = obj;

            for (let i = 0; i < parts.length - 1; i++) {
                current = current[parts[i]];
                if (!current) return false;
            }

            const lastPart = parts[parts.length - 1];
            if (current[lastPart] &&
                current[lastPart]['$type'] === 'UAssetAPI.PropertyTypes.Objects.TextPropertyData, UAssetAPI') {
                current[lastPart].CultureInvariantString = newValue;
                return true;
            }
            return false;
        }

        // Обновляем все найденные переводы
        translationsMap.forEach((value, key) => {
            if (updateValueByPath(originalFile, value.path, value.text)) {
                updatedCount++;
            }
        });

        console.log(`Обновлено переводов: ${updatedCount}`);

        // Сохраняем обновленный JSON
        try {
            fs.writeFileSync(paths.json, JSON.stringify(originalFile, null, 2), 'utf8');
            console.log('Переводы успешно внедрены в JSON файл');

            // Конвертируем обратно в uasset
            const success = await convertJsonToUasset(paths.json, paths.uasset);
            if (!success) {
                console.error('Не удалось сконвертировать файл обратно в UASSET');
                process.exit(1);
            }
        } catch (error) {
            console.error('Ошибка при сохранении обновленного файла:', error);
        }
    }
}

// Запускаем основную функцию
main().catch(console.error);
