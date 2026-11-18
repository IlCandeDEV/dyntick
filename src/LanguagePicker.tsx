import { Selector } from "@astryxdesign/core/Selector";
import { Icon } from "./Icons.tsx";
import { LANGUAGE_OPTIONS } from "./i18n.ts";
import { isLanguage, type Language } from "./timer.ts";

export function LanguagePicker({ language, label, onChange }: {
  language: Language;
  label: string;
  onChange: (language: Language) => void;
}) {
  return (
    <Selector label={label} isLabelHidden value={language}
      options={[...LANGUAGE_OPTIONS]} onChange={(value) => { if (isLanguage(value)) onChange(value); }}
      variant="secondary" size="sm" presentation="popover" placement="below"
      startIcon={<Icon name="globe" width="17" height="17" />}
      containerClassName="language-picker" controlClassName="language-trigger"
      data-testid="language-selector" data-language={language}
      renderValue={(option) => <span className="language-value">
        <span className="language-full">{option.label}</span>
        <span className="language-code">{option.value.toUpperCase()}</span>
      </span>} />
  );
}
