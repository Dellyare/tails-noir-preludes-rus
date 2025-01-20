// Код целиком написан нейросетью claude-3.5-sonnet
// Спасибо, что работает

const fileName = 'ReneeInternal_1-3';
const filePath = '../../Json-TailsRUS_P/BackboneStories/Content/Data/Dialogues/Act_I'

const fs = require('fs');

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

const inputPath = `${filePath}/${fileName}.json`;
const outputPath = `${filePath}/TRANSLATE-${fileName}.json`;

if (mode === 'extract') {
    const input = readJsonFile(inputPath);
    if (!input) process.exit(1);

    const allTexts = findAllTextProperties(input)
        .filter(item => item.value !== null && item.path !== null); // Дополнительная проверка

    const translations = allTexts.map(item => ({
        path: item.path,
        key: item.value,
        text: item.text,
        originalText: item.text,
    }));

    try {
        fs.writeFileSync(outputPath, JSON.stringify(translations, null, 2), 'utf8');
        console.log(`Найдено и сохранено ${translations.length} текстов`);
    } catch (error) {
        console.error('Ошибка при сохранении файла:', error);
    }
} else if (mode === 'inject') {
    const originalFile = readJsonFile(inputPath);
    const translations = readJsonFile(outputPath);

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

    // Сохраняем обновленный файл
    try {
        fs.writeFileSync(inputPath, JSON.stringify(originalFile, null, 2), 'utf8');
        console.log('Переводы успешно внедрены в файл:', inputPath);
    } catch (error) {
        console.error('Ошибка при сохранении обновленного файла:', error);
    }
}
