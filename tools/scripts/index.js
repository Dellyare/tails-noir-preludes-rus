// Код целиком написан нейросетью claude-3.5-sonnet
// Спасибо, что работает

const fileName = 'DT_ReneeTerminal';
const RELATIVE_PATH = 'BackboneStories/Content/Data/Datatables/Terminal';

// Базовые пути к папкам
const UASSET_ROOT = '../../TailsRUS_P';
const JSON_ROOT = '../../Json-TailsRUS_P';

import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { parse, stringify } from 'lossless-json';

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
        const rawData = fs.readFileSync(filePath, 'utf8');
        const jsonData = parse(rawData);
        return jsonData;
    } catch (error) {
        console.error('Ошибка при чтении или парсинге JSON файла');
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

// Получаем аргумент из командной строки: 'extract', 'inject' или 'bulk-inject'
const mode = process.argv[2] || 'extract';

// Добавляем функцию для поиска всех файлов переводов
function findAllTranslateFiles(directory) {
    const files = [];
    const items = fs.readdirSync(directory, { withFileTypes: true });

    for (const item of items) {
        const fullPath = path.join(directory, item.name);
        if (item.isDirectory()) {
            files.push(...findAllTranslateFiles(fullPath));
        } else if (item.name.startsWith('TRANSLATE-') && item.name.endsWith('.json')) {
            files.push(fullPath);
        }
    }

    return files;
}

// Функция для обработки одного файла перевода
async function processTranslateFile(translateJsonPath) {
    const relativePath = path.relative(JSON_ROOT, path.dirname(translateJsonPath));
    const baseName = path.basename(translateJsonPath).replace('TRANSLATE-', '');
    const fileName = baseName.replace('.json', '');

    console.log(`\nОбработка файла: ${fileName}`);
    const paths = getFilePaths(relativePath, fileName);

    const originalFile = readJsonFile(paths.json);
    const translations = readJsonFile(paths.translateJson);

    if (!originalFile || !translations) {
        console.error(`Ошибка: Не удалось прочитать файлы для ${fileName}`);
        return false;
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

    try {
        fs.writeFileSync(paths.json, stringify(originalFile, null, 2), 'utf8');
        console.log('Переводы успешно внедрены в JSON файл');

        const success = await convertJsonToUasset(paths.json, paths.uasset);
        if (!success) {
            console.error(`Ошибка: Не удалось сконвертировать файл ${fileName} обратно в UASSET`);
            return false;
        }
        return true;
    } catch (error) {
        console.error(`Ошибка при обработке файла ${fileName}:`, error);
        return false;
    }
}

// Добавляем новую функцию для работы с UAssetGUI
function executeUAssetGUI(args) {
    return new Promise((resolve, reject) => {
        const uassetGuiPath = path.resolve(process.cwd(), '../utils/UAssetGUI');

        execFile(uassetGuiPath, [...args, 'TailsNoir'], (error, stdout, stderr) => {
            if (error) {
                console.error('Ошибка при выполнении UAssetGUI');
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
        console.error('Ошибка при конвертации в JSON');
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
        console.error('Ошибка при конвертации в UASSET: ', error.message.split('\n')[1]);
        return false;
    }
}

// Модифицируем основную логику
async function main() {
    if (mode === 'extract') {
        // Создаем директорию для JSON если её нет
        const paths = getFilePaths(RELATIVE_PATH, fileName);

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
            fs.writeFileSync(paths.translateJson, stringify(translations, null, 2), 'utf8');
            console.log(`Найдено и сохранено ${translations.length} текстов`);
        } catch (error) {
            console.error('Ошибка при сохранении файла:', error);
        }
    } else if (mode === 'inject') {
        const paths = getFilePaths(RELATIVE_PATH, fileName);

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
            fs.writeFileSync(paths.json, stringify(originalFile, null, 2), 'utf8');
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
    } else if (mode === 'bulk-inject') {
        console.log('Запуск массового внедрения переводов...');
        const translateFiles = findAllTranslateFiles(JSON_ROOT);
        console.log(`Найдено файлов переводов: ${translateFiles.length}`);

        let successCount = 0;
        let failCount = 0;

        for (const file of translateFiles) {
            const success = await processTranslateFile(file);
            if (success) {
                successCount++;
            } else {
                failCount++;
            }
        }

        console.log('\nРезультаты массового внедрения:');
        console.log(`Успешно обработано: ${successCount}`);
        console.log(`Ошибок обработки: ${failCount}`);
    } else {
        console.error('Неизвестный режим работы. Используйте: extract, inject или bulk-inject');
        process.exit(1);
    }
}

// Запускаем основную функцию
main().catch(console.error);
