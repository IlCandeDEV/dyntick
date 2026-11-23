import { SelectMenu } from "./SelectMenu.tsx";
import { LANGUAGE_OPTIONS } from "./i18n.ts";
import { isLanguage, type Language } from "./timer.ts";

export function LanguagePicker({ language, label, onChange, disabled = false }: {
  language: Language;
  label: string;
  onChange: (language: Language) => void;
  disabled?: boolean;
}) {
  return (
    <SelectMenu label={label} icon="globe" className="language-picker" value={language} isDisabled={disabled}
      options={[...LANGUAGE_OPTIONS]} onChange={(value) => { if (isLanguage(value)) onChange(value); }}
      data-testid="language-selector" data-language={language}
      renderValue={(option) => <span className="language-value">
        <span className="language-full">{option.label}</span>
        <span className="language-code">{option.value.toUpperCase()}</span>
      </span>} />
  );
}
