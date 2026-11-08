/**
 * Seed for the shared ingredient map: common ingredients in Saudi restaurant kitchens.
 * Each entry: slug, English, Arabic, category, base unit, extra aliases (any language),
 * allergens, and optional physical data for cross-unit conversion.
 *
 * Aliases are normalised with normalizeName() before storage, so spelling variants,
 * diacritics and pack sizes don't matter here.
 */

export interface CanonicalSeed {
  slug: string;
  en: string;
  ar: string;
  category: string;
  unit: 'g' | 'ml' | 'each';
  aliases?: string[];
  allergens?: string[];
  density?: number; // g per ml
  eachG?: number; // g per piece
}

const S = (
  slug: string,
  en: string,
  ar: string,
  category: string,
  unit: 'g' | 'ml' | 'each',
  aliases: string[] = [],
  extra: Partial<Pick<CanonicalSeed, 'allergens' | 'density' | 'eachG'>> = {},
): CanonicalSeed => ({ slug, en, ar, category, unit, aliases, ...extra });

export const CANONICAL_SEED: CanonicalSeed[] = [
  // Produce
  S('tomato', 'Tomato', 'طماطم', 'produce', 'g', ['tomatoes', 'tomato round', 'tomato rnd', 'بندورة', 'طماطم بلدي']),
  S('cherry-tomato', 'Cherry tomato', 'طماطم كرزية', 'produce', 'g', ['cherry tomatoes', 'طماطم شيري']),
  S('onion-red', 'Red onion', 'بصل أحمر', 'produce', 'g', ['onion red', 'red onions']),
  S('onion-white', 'White onion', 'بصل أبيض', 'produce', 'g', ['onion', 'onions', 'onion white', 'yellow onion', 'بصل']),
  S('spring-onion', 'Spring onion', 'بصل أخضر', 'produce', 'g', ['green onion', 'scallion', 'spring onions']),
  S('garlic', 'Garlic', 'ثوم', 'produce', 'g', ['garlic bulb', 'fresh garlic', 'ثوم صيني']),
  S('garlic-peeled', 'Peeled garlic', 'ثوم مقشر', 'produce', 'g', ['garlic peeled', 'peeled garlic cloves']),
  S('ginger', 'Ginger', 'زنجبيل', 'produce', 'g', ['fresh ginger', 'ginger root']),
  S('potato', 'Potato', 'بطاطس', 'produce', 'g', ['potatoes', 'بطاطا']),
  S('sweet-potato', 'Sweet potato', 'بطاطا حلوة', 'produce', 'g', ['sweet potatoes']),
  S('carrot', 'Carrot', 'جزر', 'produce', 'g', ['carrots']),
  S('cucumber', 'Cucumber', 'خيار', 'produce', 'g', ['cucumbers']),
  S('lettuce-iceberg', 'Iceberg lettuce', 'خس آيسبرغ', 'produce', 'g', ['iceberg', 'lettuce iceberg', 'خس امريكي']),
  S('lettuce-romaine', 'Romaine lettuce', 'خس روماني', 'produce', 'g', ['romaine', 'cos lettuce', 'lettuce romaine', 'خس']),
  S('cabbage', 'Cabbage', 'ملفوف', 'produce', 'g', ['white cabbage', 'كرنب']),
  S('bell-pepper-green', 'Green bell pepper', 'فلفل رومي أخضر', 'produce', 'g', ['capsicum green', 'green capsicum', 'فلفل حلو اخضر']),
  S('bell-pepper-red', 'Red bell pepper', 'فلفل رومي أحمر', 'produce', 'g', ['capsicum red', 'red capsicum']),
  S('bell-pepper-yellow', 'Yellow bell pepper', 'فلفل رومي أصفر', 'produce', 'g', ['capsicum yellow', 'yellow capsicum']),
  S('chili-green', 'Green chili', 'فلفل حار أخضر', 'produce', 'g', ['green chilli', 'hot pepper green', 'فلفل حار']),
  S('jalapeno', 'Jalapeño', 'هالبينو', 'produce', 'g', ['jalapeno pepper', 'jalapenos']),
  S('eggplant', 'Eggplant', 'باذنجان', 'produce', 'g', ['aubergine', 'brinjal']),
  S('zucchini', 'Zucchini', 'كوسا', 'produce', 'g', ['courgette', 'كوسة']),
  S('mushroom-button', 'Button mushroom', 'فطر', 'produce', 'g', ['mushroom', 'mushrooms', 'champignon', 'مشروم']),
  S('broccoli', 'Broccoli', 'بروكلي', 'produce', 'g'),
  S('cauliflower', 'Cauliflower', 'قرنبيط', 'produce', 'g', ['زهرة']),
  S('spinach', 'Spinach', 'سبانخ', 'produce', 'g', ['baby spinach']),
  S('parsley', 'Parsley', 'بقدونس', 'produce', 'g', ['flat parsley', 'parsley bunch', 'بقدونس حزمة']),
  S('coriander', 'Coriander', 'كزبرة', 'produce', 'g', ['cilantro', 'coriander leaves', 'كزبرة خضراء']),
  S('mint', 'Mint', 'نعناع', 'produce', 'g', ['fresh mint', 'mint leaves']),
  S('basil', 'Basil', 'ريحان', 'produce', 'g', ['fresh basil', 'حبق']),
  S('dill', 'Dill', 'شبت', 'produce', 'g'),
  S('rocket', 'Rocket', 'جرجير', 'produce', 'g', ['arugula', 'roquette']),
  S('lemon', 'Lemon', 'ليمون', 'produce', 'g', ['lemons', 'ليمون اصفر']),
  S('lime', 'Lime', 'ليمون أخضر', 'produce', 'g', ['limes', 'ليمون بنزهير']),
  S('avocado', 'Avocado', 'أفوكادو', 'produce', 'each', ['avocados'], { eachG: 200 }),
  S('banana', 'Banana', 'موز', 'produce', 'g', ['bananas']),
  S('apple', 'Apple', 'تفاح', 'produce', 'g', ['apples', 'red apple']),
  S('orange', 'Orange', 'برتقال', 'produce', 'g', ['oranges']),
  S('strawberry', 'Strawberry', 'فراولة', 'produce', 'g', ['strawberries']),
  S('mango', 'Mango', 'مانجو', 'produce', 'g', ['mangoes', 'منجا']),
  S('watermelon', 'Watermelon', 'بطيخ', 'produce', 'g', ['حبحب']),
  S('dates', 'Dates', 'تمر', 'produce', 'g', ['date fruit', 'تمور', 'تمر سكري', 'تمر خلاص']),

  // Meat & poultry
  S('chicken-whole', 'Whole chicken', 'دجاج كامل', 'poultry', 'g', ['chicken whole', 'whole chicken fresh', 'دجاج طازج', 'فروج']),
  S('chicken-breast', 'Chicken breast', 'صدور دجاج', 'poultry', 'g', ['chicken breast boneless', 'chicken fillet', 'boneless chicken breast', 'صدر دجاج', 'فيليه دجاج']),
  S('chicken-thigh', 'Chicken thigh', 'أفخاذ دجاج', 'poultry', 'g', ['chicken thigh boneless', 'boneless thigh', 'فخذ دجاج', 'افخاذ دجاج مخلية']),
  S('chicken-wings', 'Chicken wings', 'أجنحة دجاج', 'poultry', 'g', ['wings', 'chicken wing', 'جوانح دجاج']),
  S('chicken-drumstick', 'Chicken drumstick', 'دبابيس دجاج', 'poultry', 'g', ['drumsticks']),
  S('beef-mince', 'Beef mince', 'لحم بقري مفروم', 'meat', 'g', ['minced beef', 'ground beef', 'beef minced', 'مفروم بقري']),
  S('beef-tenderloin', 'Beef tenderloin', 'تندرلوين بقري', 'meat', 'g', ['tenderloin', 'beef fillet', 'فيليه لحم']),
  S('beef-striploin', 'Beef striploin', 'ستريبلوين بقري', 'meat', 'g', ['striploin', 'sirloin', 'ستيك']),
  S('beef-ribeye', 'Beef ribeye', 'ريب آي بقري', 'meat', 'g', ['ribeye', 'rib eye']),
  S('lamb-leg', 'Lamb leg', 'فخذ غنم', 'meat', 'g', ['leg of lamb', 'لحم غنم', 'فخذ ضان']),
  S('lamb-shoulder', 'Lamb shoulder', 'كتف غنم', 'meat', 'g', ['shoulder lamb', 'كتف ضان']),
  S('lamb-mince', 'Lamb mince', 'لحم غنم مفروم', 'meat', 'g', ['minced lamb', 'ground lamb']),
  S('camel-meat', 'Camel meat', 'لحم حاشي', 'meat', 'g', ['camel', 'حاشي', 'لحم ابل']),
  S('beef-burger-patty', 'Beef burger patty', 'برجر لحم', 'meat', 'g', ['burger patty', 'beef patty', 'patty']),
  S('turkey-breast', 'Turkey breast', 'صدر حبش', 'poultry', 'g', ['smoked turkey', 'turkey', 'صدر ديك رومي']),

  // Seafood
  S('salmon-fillet', 'Salmon fillet', 'فيليه سلمون', 'seafood', 'g', ['salmon', 'norwegian salmon', 'سلمون'], { allergens: ['fish'] }),
  S('shrimp', 'Shrimp', 'روبيان', 'seafood', 'g', ['prawns', 'prawn', 'shrimps', 'جمبري'], { allergens: ['crustaceans'] }),
  S('hammour', 'Hammour', 'هامور', 'seafood', 'g', ['grouper', 'hamour'], { allergens: ['fish'] }),
  S('tuna-canned', 'Canned tuna', 'تونة معلبة', 'seafood', 'g', ['tuna', 'tuna can', 'tuna chunks', 'تونة'], { allergens: ['fish'] }),
  S('calamari', 'Calamari', 'كاليماري', 'seafood', 'g', ['squid', 'حبار'], { allergens: ['molluscs'] }),

  // Dairy & eggs
  S('milk-full-fat', 'Full-fat milk', 'حليب كامل الدسم', 'dairy', 'ml', ['milk', 'fresh milk', 'milk full fat', 'حليب', 'حليب طازج'], { allergens: ['milk'], density: 1.03 }),
  S('milk-low-fat', 'Low-fat milk', 'حليب قليل الدسم', 'dairy', 'ml', ['milk low fat', 'skimmed milk'], { allergens: ['milk'], density: 1.03 }),
  S('cream-cooking', 'Cooking cream', 'كريمة طبخ', 'dairy', 'ml', ['cooking cream', 'cream', 'كريمة'], { allergens: ['milk'], density: 1.0 }),
  S('cream-whipping', 'Whipping cream', 'كريمة خفق', 'dairy', 'ml', ['whipping cream', 'heavy cream', 'كريمة شانتيه'], { allergens: ['milk'], density: 1.0 }),
  S('butter-unsalted', 'Unsalted butter', 'زبدة غير مملحة', 'dairy', 'g', ['butter', 'butter unsalted', 'زبدة'], { allergens: ['milk'] }),
  S('labneh', 'Labneh', 'لبنة', 'dairy', 'g', ['labna', 'labneh full fat'], { allergens: ['milk'] }),
  S('yogurt', 'Yoghurt', 'زبادي', 'dairy', 'g', ['yogurt', 'plain yogurt', 'روب', 'لبن زبادي'], { allergens: ['milk'] }),
  S('laban', 'Laban', 'لبن', 'dairy', 'ml', ['buttermilk', 'لبن عيران'], { allergens: ['milk'], density: 1.03 }),
  S('cheese-mozzarella', 'Mozzarella', 'جبن موزاريلا', 'dairy', 'g', ['mozzarella cheese', 'shredded mozzarella', 'موزاريلا'], { allergens: ['milk'] }),
  S('cheese-cheddar', 'Cheddar', 'جبن شيدر', 'dairy', 'g', ['cheddar cheese', 'cheddar slices', 'شيدر'], { allergens: ['milk'] }),
  S('cheese-feta', 'Feta', 'جبن فيتا', 'dairy', 'g', ['feta cheese', 'white cheese', 'جبنة بيضاء'], { allergens: ['milk'] }),
  S('cheese-halloumi', 'Halloumi', 'جبن حلوم', 'dairy', 'g', ['halloumi cheese', 'حلومي'], { allergens: ['milk'] }),
  S('cheese-parmesan', 'Parmesan', 'جبن بارميزان', 'dairy', 'g', ['parmesan cheese', 'parmigiano'], { allergens: ['milk'] }),
  S('cream-cheese', 'Cream cheese', 'جبن كريمي', 'dairy', 'g', ['cream cheese spread', 'جبنة كريمية'], { allergens: ['milk'] }),
  S('eggs', 'Eggs', 'بيض', 'eggs', 'each', ['egg', 'fresh eggs', 'eggs large', 'بيض طازج', 'بيض مائدة'], { allergens: ['eggs'], eachG: 60 }),

  // Grains, bakery, dry goods
  S('rice-basmati', 'Basmati rice', 'أرز بسمتي', 'grains', 'g', ['basmati', 'rice basmati', 'رز بسمتي', 'ارز']),
  S('rice-egyptian', 'Egyptian rice', 'أرز مصري', 'grains', 'g', ['calrose rice', 'short grain rice', 'رز مصري']),
  S('flour-all-purpose', 'All-purpose flour', 'دقيق متعدد الاستخدامات', 'dry_goods', 'g', ['flour', 'plain flour', 'wheat flour', 'طحين', 'دقيق'], { allergens: ['gluten'] }),
  S('semolina', 'Semolina', 'سميد', 'dry_goods', 'g', ['semolina flour'], { allergens: ['gluten'] }),
  S('pasta-penne', 'Penne pasta', 'مكرونة بيني', 'dry_goods', 'g', ['penne', 'pasta penne'], { allergens: ['gluten'] }),
  S('pasta-spaghetti', 'Spaghetti', 'سباغيتي', 'dry_goods', 'g', ['spaghetti pasta', 'مكرونة اسباغيتي'], { allergens: ['gluten'] }),
  S('bread-burger-bun', 'Burger bun', 'خبز برجر', 'bakery', 'each', ['burger buns', 'bun', 'brioche bun', 'خبز همبرجر'], { allergens: ['gluten'], eachG: 60 }),
  S('bread-arabic', 'Arabic bread', 'خبز عربي', 'bakery', 'each', ['pita', 'pita bread', 'khubz', 'خبز لبناني'], { allergens: ['gluten'], eachG: 80 }),
  S('bread-tortilla', 'Tortilla wrap', 'خبز تورتيلا', 'bakery', 'each', ['tortilla', 'wrap', 'wraps', 'تورتيلا'], { allergens: ['gluten'], eachG: 60 }),
  S('bread-toast', 'Toast bread', 'خبز توست', 'bakery', 'g', ['sliced bread', 'toast'], { allergens: ['gluten'] }),
  S('breadcrumbs', 'Breadcrumbs', 'بقسماط', 'dry_goods', 'g', ['bread crumbs', 'panko', 'فتات خبز'], { allergens: ['gluten'] }),
  S('lentils-red', 'Red lentils', 'عدس أحمر', 'dry_goods', 'g', ['lentils', 'red lentil', 'عدس']),
  S('chickpeas', 'Chickpeas', 'حمص حب', 'dry_goods', 'g', ['garbanzo', 'chick peas', 'حمص']),
  S('tahini', 'Tahini', 'طحينة', 'sauces', 'g', ['tahina', 'sesame paste'], { allergens: ['sesame'] }),
  S('sugar-white', 'White sugar', 'سكر أبيض', 'dry_goods', 'g', ['sugar', 'granulated sugar', 'سكر']),
  S('salt', 'Salt', 'ملح', 'spices', 'g', ['table salt', 'fine salt', 'ملح طعام']),
  S('honey', 'Honey', 'عسل', 'dry_goods', 'g', ['natural honey', 'عسل طبيعي']),
  S('oats', 'Oats', 'شوفان', 'grains', 'g', ['rolled oats', 'oat flakes'], { allergens: ['gluten'] }),
  S('almonds', 'Almonds', 'لوز', 'dry_goods', 'g', ['almond', 'sliced almonds'], { allergens: ['tree_nuts'] }),
  S('pistachio', 'Pistachio', 'فستق حلبي', 'dry_goods', 'g', ['pistachios', 'فستق'], { allergens: ['tree_nuts'] }),
  S('walnuts', 'Walnuts', 'عين جمل', 'dry_goods', 'g', ['walnut', 'جوز'], { allergens: ['tree_nuts'] }),
  S('sesame-seeds', 'Sesame seeds', 'سمسم', 'dry_goods', 'g', ['sesame'], { allergens: ['sesame'] }),
  S('cocoa-powder', 'Cocoa powder', 'كاكاو', 'dry_goods', 'g', ['cocoa']),
  S('chocolate-dark', 'Dark chocolate', 'شوكولاتة داكنة', 'dry_goods', 'g', ['dark chocolate', 'chocolate', 'chocolate couverture'], { allergens: ['milk', 'soy'] }),
  S('coffee-beans', 'Coffee beans', 'حبوب قهوة', 'beverages', 'g', ['coffee', 'espresso beans', 'بن', 'قهوة']),
  S('arabic-coffee', 'Arabic coffee', 'قهوة عربية', 'beverages', 'g', ['saudi coffee', 'قهوة سعودية', 'بن عربي']),
  S('tea-black', 'Black tea', 'شاي أسود', 'beverages', 'g', ['tea', 'tea leaves', 'شاي']),

  // Oils, sauces, spices
  S('oil-vegetable', 'Vegetable oil', 'زيت نباتي', 'oils_fats', 'ml', ['cooking oil', 'frying oil', 'sunflower oil', 'corn oil', 'زيت طبخ', 'زيت ذرة', 'زيت دوار الشمس'], { density: 0.92 }),
  S('oil-olive', 'Olive oil', 'زيت زيتون', 'oils_fats', 'ml', ['extra virgin olive oil', 'olive oil extra virgin', 'evoo', 'زيت زيتون بكر'], { density: 0.91 }),
  S('ghee', 'Ghee', 'سمن', 'oils_fats', 'g', ['clarified butter', 'samn', 'سمن بلدي'], { allergens: ['milk'] }),
  S('ketchup', 'Ketchup', 'كاتشب', 'sauces', 'g', ['tomato ketchup']),
  S('mayonnaise', 'Mayonnaise', 'مايونيز', 'sauces', 'g', ['mayo'], { allergens: ['eggs'] }),
  S('mustard', 'Mustard', 'خردل', 'sauces', 'g', ['yellow mustard', 'mustard sauce'], { allergens: ['mustard'] }),
  S('tomato-paste', 'Tomato paste', 'معجون طماطم', 'sauces', 'g', ['tomato puree', 'صلصة طماطم']),
  S('soy-sauce', 'Soy sauce', 'صلصة الصويا', 'sauces', 'ml', ['soya sauce'], { allergens: ['soy', 'gluten'], density: 1.2 }),
  S('vinegar-white', 'White vinegar', 'خل أبيض', 'sauces', 'ml', ['vinegar', 'خل'], { density: 1.01 }),
  S('hot-sauce', 'Hot sauce', 'صلصة حارة', 'sauces', 'ml', ['chili sauce', 'sriracha', 'شطة'], { density: 1.1 }),
  S('black-pepper', 'Black pepper', 'فلفل أسود', 'spices', 'g', ['pepper black', 'ground black pepper', 'بهار اسود']),
  S('cumin', 'Cumin', 'كمون', 'spices', 'g', ['cumin powder', 'ground cumin']),
  S('paprika', 'Paprika', 'بابريكا', 'spices', 'g', ['paprika powder', 'فلفل احمر حلو']),
  S('turmeric', 'Turmeric', 'كركم', 'spices', 'g', ['turmeric powder']),
  S('cardamom', 'Cardamom', 'هيل', 'spices', 'g', ['cardamom pods', 'حب الهيل']),
  S('saffron', 'Saffron', 'زعفران', 'spices', 'g', ['saffron threads']),
  S('cinnamon', 'Cinnamon', 'قرفة', 'spices', 'g', ['cinnamon sticks', 'cinnamon powder', 'دارسين']),
  S('mixed-spices', 'Mixed spices', 'بهارات مشكلة', 'spices', 'g', ['baharat', 'kabsa spice', 'بهارات كبسة', 'بهارات']),
  S('zaatar', "Za'atar", 'زعتر', 'spices', 'g', ['zatar', 'thyme mix'], { allergens: ['sesame'] }),
  S('sumac', 'Sumac', 'سماق', 'spices', 'g'),

  // Frozen
  S('fries-frozen', 'Frozen fries', 'بطاطس مقلية مجمدة', 'frozen', 'g', ['french fries', 'fries', 'chips frozen', 'بطاطس مجمدة', 'بطاطس فرايز']),
  S('mixed-vegetables-frozen', 'Frozen mixed vegetables', 'خضار مشكلة مجمدة', 'frozen', 'g', ['mixed vegetables', 'frozen veg']),

  // Beverages
  S('water-bottled', 'Bottled water', 'مياه معبأة', 'beverages', 'ml', ['water', 'mineral water', 'drinking water', 'مياه', 'ماء'], { density: 1 }),
  S('soft-drink-cola', 'Cola', 'مشروب غازي كولا', 'beverages', 'ml', ['cola', 'soft drink', 'soda', 'مشروب غازي', 'بيبسي', 'pepsi'], { density: 1.04 }),
  S('juice-orange', 'Orange juice', 'عصير برتقال', 'beverages', 'ml', ['orange juice', 'oj'], { density: 1.04 }),

  // Packaging & cleaning
  S('takeaway-container', 'Takeaway container', 'علبة سفري', 'packaging', 'each', ['food container', 'disposable container', 'container', 'علب سفري']),
  S('paper-cup', 'Paper cup', 'كوب ورقي', 'packaging', 'each', ['coffee cup', 'cups', 'اكواب ورقية']),
  S('napkins', 'Napkins', 'مناديل', 'packaging', 'each', ['tissue', 'paper napkins', 'serviette']),
  S('gloves', 'Disposable gloves', 'قفازات', 'cleaning', 'each', ['gloves', 'nitrile gloves', 'vinyl gloves', 'جوانتي']),
  S('dish-soap', 'Dishwashing liquid', 'سائل غسيل الصحون', 'cleaning', 'ml', ['dish soap', 'dishwashing detergent', 'صابون صحون'], { density: 1.03 }),
];
